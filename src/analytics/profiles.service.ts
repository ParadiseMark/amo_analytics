/**
 * Manager profile computation.
 * Reads 30-day KPIs from ClickHouse, computes percentiles within the account,
 * determines strengths/weaknesses, writes profile snapshots back to ClickHouse.
 */
import { query, insert } from "../lib/clickhouse/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ManagerProfile = {
  account_id: string;
  user_amo_id: number;
  snapshot_week: string;
  percentile_revenue: number;
  percentile_win_rate: number;
  percentile_response: number;
  percentile_calls: number;
  revenue_30d: number;
  win_rate_30d: number;
  deals_won_30d: number;
  calls_made_30d: number;
  response_time_30d: number;
  revenue_trend: number;
  profile_json: string;
};

type ProfileData = {
  strengths: string[];
  weaknesses: string[];
  trend: "improving" | "stable" | "declining";
};

// ─── Profile computation ─────────────────────────────────────────────────────

export async function computeManagerProfiles(accountId: string): Promise<void> {
  const snapshotWeek = getMonday(new Date());
  const thirtyDaysAgo = formatDate(daysAgo(30));
  const today = formatDate(new Date());

  // ── Fetch 30-day aggregated KPIs per manager from ClickHouse ──────────────
  type KpiAgg = {
    user_amo_id: number;
    revenue_30d: number;
    win_rate_30d: number;
    deals_won_30d: number;
    calls_made_30d: number;
    response_time_30d: number;
  };

  const kpis = await query<KpiAgg>(`
    SELECT
      user_amo_id,
      sumMerge(revenue_won)       AS revenue_30d,
      avgMerge(win_rate)          AS win_rate_30d,
      sumMerge(deals_won)         AS deals_won_30d,
      sumMerge(calls_made)        AS calls_made_30d,
      avgMerge(response_time_p50) AS response_time_30d
    FROM (
      SELECT
        user_amo_id,
        sumState(revenue_won)       AS revenue_won,
        avgState(win_rate)          AS win_rate,
        sumState(deals_won)         AS deals_won,
        sumState(calls_made)        AS calls_made,
        avgState(response_time_p50) AS response_time_p50
      FROM daily_manager_kpis FINAL
      WHERE
        account_id = {accountId: String}
        AND date >= {startDate: String}
        AND date <= {endDate: String}
      GROUP BY user_amo_id
    )
    GROUP BY user_amo_id
    HAVING user_amo_id > 0
  `, { accountId, startDate: thirtyDaysAgo, endDate: today });

  if (kpis.length === 0) return;

  // ── Fetch 12-week revenue trend per manager ────────────────────────────────
  type TrendRow = {
    user_amo_id: number;
    week: string;
    revenue: number;
  };

  const trendRows = await query<TrendRow>(`
    SELECT
      user_amo_id,
      toMonday(date)   AS week,
      sum(revenue_won) AS revenue
    FROM daily_manager_kpis FINAL
    WHERE
      account_id = {accountId: String}
      AND date >= {trendStart: String}
    GROUP BY user_amo_id, week
    ORDER BY user_amo_id, week
  `, { accountId, trendStart: formatDate(daysAgo(84)) }); // 12 weeks

  // ── Compute percentiles within the account ────────────────────────────────
  const revenues = kpis.map((k) => k.revenue_30d).sort((a, b) => a - b);
  const winRates = kpis.map((k) => k.win_rate_30d).sort((a, b) => a - b);
  const responseTimes = kpis.map((k) => k.response_time_30d).sort((a, b) => a - b);
  const callsMade = kpis.map((k) => k.calls_made_30d).sort((a, b) => a - b);

  // Account-level averages (for strength/weakness thresholds)
  const avgRevenue = mean(revenues);
  const avgWinRate = mean(winRates);
  const avgResponse = mean(responseTimes);
  const avgCalls = mean(callsMade);

  // Revenue trend map: user_amo_id → slope
  const trendMap = computeTrendSlopes(trendRows);

  // ── Build profile for each manager ────────────────────────────────────────
  const profiles: ManagerProfile[] = kpis.map((kpi) => {
    const pRevenue = percentileOf(revenues, kpi.revenue_30d);
    const pWinRate = percentileOf(winRates, kpi.win_rate_30d);
    // For response time: lower is better, so invert percentile
    const pResponse = 100 - percentileOf(responseTimes, kpi.response_time_30d);
    const pCalls = percentileOf(callsMade, kpi.calls_made_30d);

    const trend = trendMap.get(kpi.user_amo_id) ?? 0;
    const trendLabel: ProfileData["trend"] =
      trend > 0.05 * avgRevenue ? "improving"
      : trend < -0.05 * avgRevenue ? "declining"
      : "stable";

    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // Revenue
    if (pRevenue >= 75) strengths.push("high_revenue");
    else if (pRevenue <= 25) weaknesses.push("low_revenue");

    // Win rate
    if (kpi.win_rate_30d > avgWinRate * 1.15) strengths.push("high_win_rate");
    else if (kpi.win_rate_30d < avgWinRate * 0.75) weaknesses.push("low_win_rate");

    // Response time (fast = good)
    if (pResponse >= 75) strengths.push("fast_response_time");
    else if (pResponse <= 25) weaknesses.push("slow_response_time");

    // Call volume
    if (kpi.calls_made_30d > avgCalls * 1.2) strengths.push("high_call_rate");
    else if (kpi.calls_made_30d < avgCalls * 0.6) weaknesses.push("low_call_rate");

    // Trend
    if (trendLabel === "improving") strengths.push("improving_trend");
    else if (trendLabel === "declining") weaknesses.push("declining_trend");

    const profileData: ProfileData = { strengths, weaknesses, trend: trendLabel };

    return {
      account_id: accountId,
      user_amo_id: kpi.user_amo_id,
      snapshot_week: snapshotWeek,
      percentile_revenue: Math.round(pRevenue),
      percentile_win_rate: Math.round(pWinRate),
      percentile_response: Math.round(pResponse),
      percentile_calls: Math.round(pCalls),
      revenue_30d: kpi.revenue_30d,
      win_rate_30d: kpi.win_rate_30d,
      deals_won_30d: kpi.deals_won_30d,
      calls_made_30d: kpi.calls_made_30d,
      response_time_30d: kpi.response_time_30d,
      revenue_trend: trend,
      profile_json: JSON.stringify(profileData),
    };
  });

  await insert("manager_profiles", profiles);
  console.log(`[profiles] Wrote ${profiles.length} profiles for account=${accountId}`);
}

/**
 * Get the latest profile for a single manager.
 * Used by the AI assistant.
 */
export async function getManagerProfile(
  accountId: string,
  userAmoId: number
): Promise<(ManagerProfile & { profile: ProfileData }) | null> {
  const rows = await query<ManagerProfile>(`
    SELECT *
    FROM manager_profiles FINAL
    WHERE account_id = {accountId: String}
      AND user_amo_id = {userAmoId: UInt32}
    ORDER BY snapshot_week DESC
    LIMIT 1
  `, { accountId, userAmoId });

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    profile: JSON.parse(row.profile_json) as ProfileData,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function percentileOf(sorted: number[], value: number): number {
  if (sorted.length === 0) return 50;
  const below = sorted.filter((v) => v < value).length;
  return (below / sorted.length) * 100;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeTrendSlopes(
  rows: Array<{ user_amo_id: number; week: string; revenue: number }>
): Map<number, number> {
  const byUser = new Map<number, { week: number; revenue: number }[]>();
  for (const r of rows) {
    if (!byUser.has(r.user_amo_id)) byUser.set(r.user_amo_id, []);
    byUser.get(r.user_amo_id)!.push({
      week: new Date(r.week).getTime(),
      revenue: r.revenue,
    });
  }

  const slopes = new Map<number, number>();
  for (const [userId, points] of byUser) {
    if (points.length < 3) { slopes.set(userId, 0); continue; }
    slopes.set(userId, linearRegressionSlope(points));
  }
  return slopes;
}

function linearRegressionSlope(
  points: { week: number; revenue: number }[]
): number {
  const n = points.length;
  const xMean = mean(points.map((p) => p.week));
  const yMean = mean(points.map((p) => p.revenue));
  const num = points.reduce((s, p) => s + (p.week - xMean) * (p.revenue - yMean), 0);
  const den = points.reduce((s, p) => s + (p.week - xMean) ** 2, 0);
  if (den === 0) return 0;
  // Convert slope per ms → slope per week (relative to avg revenue)
  return (num / den) * (7 * 24 * 3600 * 1000);
}

function getMonday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return formatDate(date);
}

function formatDate(d: Date): string {
  return d.toISOString().substring(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
