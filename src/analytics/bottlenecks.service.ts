/**
 * Bottleneck detection service.
 * Identifies:
 *  1. Funnel stages where avg time-in-stage > 1.5x account average
 *  2. Managers whose win_rate < account mean − 1 std dev
 *  3. Deals with no activity for > threshold days (stuck deals)
 *
 * Writes results to PostgreSQL bottleneck_alerts table.
 */
import { sql, eq, and, lt, isNull, ne } from "drizzle-orm";
import { db } from "../lib/db/index.js";
import { deals, tasks, notes, calls, bottleneckAlerts, accounts } from "../lib/db/schema.js";
import { query } from "../lib/clickhouse/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type StageBottleneck = {
  pipeline_amo_id: number;
  stage_amo_id: number;
  avg_days: number;
  account_avg_days: number;
  multiplier: number;
};

type ManagerBottleneck = {
  user_amo_id: number;
  win_rate: number;
  account_avg_win_rate: number;
  stddev: number;
};

// ─── Main detection job ───────────────────────────────────────────────────────

export async function runBottleneckDetection(accountId: string): Promise<void> {
  // Resolve threshold from account settings
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
    columns: { settings: true },
  });
  const settings = account?.settings ?? {};
  const bottleneckMultiplier = settings.bottleneckMultiplier ?? 1.5;
  const stuckDaysThreshold = settings.stuckDaysThreshold ?? null; // null = auto (2x avg)

  await Promise.all([
    detectStageBottlenecks(accountId, bottleneckMultiplier),
    detectManagerBottlenecks(accountId),
    detectStuckDeals(accountId, stuckDaysThreshold),
  ]);

  console.log(`[bottlenecks] Detection completed for account=${accountId}`);
}

// ─── 1. Stage bottlenecks ─────────────────────────────────────────────────────

async function detectStageBottlenecks(
  accountId: string,
  multiplier: number
): Promise<void> {
  type StageRow = {
    pipeline_amo_id: number;
    stage_amo_id: number;
    avg_hours: number;
    account_avg: number;
  };

  const rows = await query<StageRow>(`
    WITH stage_avgs AS (
      SELECT
        pipeline_amo_id,
        stage_amo_id,
        avg(duration_hours) AS avg_hours
      FROM deal_stage_time
      WHERE account_id = {accountId: String}
        AND entered_at >= now() - INTERVAL 30 DAY
      GROUP BY pipeline_amo_id, stage_amo_id
    ),
    pipeline_avg AS (
      SELECT
        pipeline_amo_id,
        avg(avg_hours) AS account_avg
      FROM stage_avgs
      GROUP BY pipeline_amo_id
    )
    SELECT
      s.pipeline_amo_id,
      s.stage_amo_id,
      s.avg_hours,
      p.account_avg
    FROM stage_avgs s
    JOIN pipeline_avg p USING (pipeline_amo_id)
    WHERE s.avg_hours > p.account_avg * {multiplier: Float32}
    ORDER BY s.avg_hours / p.account_avg DESC
  `, { accountId, multiplier });

  // Resolve previous alerts and insert new ones
  await db
    .update(bottleneckAlerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(bottleneckAlerts.accountId, accountId),
        eq(bottleneckAlerts.alertType, "stage_bottleneck"),
        isNull(bottleneckAlerts.resolvedAt)
      )
    );

  for (const r of rows) {
    await db.insert(bottleneckAlerts).values({
      accountId,
      alertType: "stage_bottleneck",
      entityType: "pipeline_stage",
      entityAmoId: r.stage_amo_id,
      severity: r.avg_hours / r.account_avg > 3 ? "critical" : "warning",
      data: {
        pipeline_amo_id: r.pipeline_amo_id,
        stage_amo_id: r.stage_amo_id,
        avg_hours: r.avg_hours,
        account_avg_hours: r.account_avg,
        multiplier: r.avg_hours / r.account_avg,
      },
    });
  }

  console.log(`[bottlenecks] ${rows.length} stage bottlenecks for account=${accountId}`);
}

// ─── 2. Manager win-rate bottlenecks ──────────────────────────────────────────

async function detectManagerBottlenecks(accountId: string): Promise<void> {
  type WinRow = {
    user_amo_id: number;
    win_rate: number;
    account_avg: number;
    stddev: number;
  };

  const rows = await query<WinRow>(`
    WITH manager_rates AS (
      SELECT
        user_amo_id,
        avg(win_rate) AS win_rate
      FROM daily_manager_kpis FINAL
      WHERE account_id = {accountId: String}
        AND date >= today() - 30
      GROUP BY user_amo_id
      HAVING user_amo_id > 0
    ),
    stats AS (
      SELECT
        avg(win_rate)    AS account_avg,
        stddevPop(win_rate) AS stddev
      FROM manager_rates
    )
    SELECT
      m.user_amo_id,
      m.win_rate,
      s.account_avg,
      s.stddev
    FROM manager_rates m
    CROSS JOIN stats s
    WHERE m.win_rate < s.account_avg - s.stddev
      AND s.stddev > 0
  `, { accountId });

  await db
    .update(bottleneckAlerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(bottleneckAlerts.accountId, accountId),
        eq(bottleneckAlerts.alertType, "low_win_rate"),
        isNull(bottleneckAlerts.resolvedAt)
      )
    );

  for (const r of rows) {
    await db.insert(bottleneckAlerts).values({
      accountId,
      alertType: "low_win_rate",
      entityType: "manager",
      entityAmoId: r.user_amo_id,
      severity: "warning",
      data: {
        user_amo_id: r.user_amo_id,
        win_rate: r.win_rate,
        account_avg: r.account_avg,
        delta_from_avg: r.win_rate - r.account_avg,
      },
    });
  }

  console.log(`[bottlenecks] ${rows.length} manager win-rate alerts for account=${accountId}`);
}

// ─── 3. Stuck deals ───────────────────────────────────────────────────────────

async function detectStuckDeals(
  accountId: string,
  thresholdDays: number | null
): Promise<void> {
  // If no explicit threshold, use 2x the average deal_velocity_avg from ClickHouse
  let threshold = thresholdDays;

  if (!threshold) {
    type VelocityRow = { avg_velocity: number };
    const [vel] = await query<VelocityRow>(`
      SELECT avg(deal_velocity_avg) AS avg_velocity
      FROM daily_manager_kpis FINAL
      WHERE account_id = {accountId: String}
        AND date >= today() - 90
    `, { accountId });
    threshold = Math.round((vel?.avg_velocity ?? 14) * 2);
    if (threshold < 7) threshold = 7; // minimum 7 days
  }

  const cutoff = new Date(Date.now() - threshold * 24 * 3600 * 1000);

  // Stuck = open deal with no notes, calls, or tasks since cutoff
  type StuckRow = { amo_id: number; responsible_user_amo_id: number; days_inactive: string };

  const stuckDeals = await db.execute<StuckRow>(sql`
    SELECT
      d.amo_id,
      d.responsible_user_amo_id,
      EXTRACT(EPOCH FROM (NOW() - GREATEST(
        d.updated_at,
        (SELECT MAX(n.created_at) FROM notes n
         WHERE n.account_id = d.account_id
           AND n.entity_type = 'leads'
           AND n.entity_amo_id = d.amo_id),
        (SELECT MAX(t.created_at) FROM tasks t
         WHERE t.account_id = d.account_id
           AND t.entity_amo_id = d.amo_id),
        (SELECT MAX(c.created_at) FROM calls c
         WHERE c.account_id = d.account_id
           AND c.entity_amo_id = d.amo_id)
      ))) / 86400.0                                    AS days_inactive
    FROM deals d
    WHERE
      d.account_id = ${accountId}
      AND d.is_deleted = false
      AND d.closed_status = 0        -- open deals only
      AND d.updated_at < ${cutoff}
    ORDER BY days_inactive DESC
    LIMIT 200
  `);

  // Resolve previous stuck deal alerts
  await db
    .update(bottleneckAlerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(bottleneckAlerts.accountId, accountId),
        eq(bottleneckAlerts.alertType, "stuck_deal"),
        isNull(bottleneckAlerts.resolvedAt)
      )
    );

  for (const d of stuckDeals.rows) {
    const daysInactive = parseFloat(d.days_inactive);
    await db.insert(bottleneckAlerts).values({
      accountId,
      alertType: "stuck_deal",
      entityType: "leads",
      entityAmoId: d.amo_id,
      severity: daysInactive > threshold * 2 ? "critical" : "warning",
      data: {
        deal_amo_id: d.amo_id,
        responsible_user_amo_id: d.responsible_user_amo_id,
        days_inactive: daysInactive,
        threshold_days: threshold,
      },
    });
  }

  console.log(`[bottlenecks] ${stuckDeals.rows.length} stuck deals (threshold=${threshold}d) for account=${accountId}`);
}

// ─── Query helpers (used by API) ──────────────────────────────────────────────

export async function getStuckDeals(
  accountId: string,
  userAmoId?: number,
  limit = 50
): Promise<Array<{
  amo_id: number;
  name: string;
  price: number;
  responsible_user_amo_id: number;
  days_inactive: number;
  pipeline_amo_id: number;
  stage_amo_id: number;
}>> {
  const userFilter = userAmoId
    ? sql`AND d.responsible_user_amo_id = ${userAmoId}`
    : sql``;

  type Row = {
    amo_id: number;
    name: string;
    price: string;
    responsible_user_amo_id: number;
    days_inactive: string;
    pipeline_amo_id: number;
    stage_amo_id: number;
  };

  const result = await db.execute<Row>(sql`
    SELECT
      d.amo_id,
      d.name,
      d.price,
      d.responsible_user_amo_id,
      d.pipeline_amo_id,
      d.stage_amo_id,
      EXTRACT(EPOCH FROM (NOW() - d.updated_at)) / 86400.0 AS days_inactive
    FROM deals d
    WHERE
      d.account_id = ${accountId}
      AND d.is_deleted = false
      AND d.closed_status = 0
      AND d.updated_at < NOW() - INTERVAL '7 days'
      ${userFilter}
    ORDER BY d.updated_at ASC
    LIMIT ${limit}
  `);

  return result.rows.map((r) => ({
    amo_id: r.amo_id,
    name: r.name,
    price: Number(r.price),
    responsible_user_amo_id: r.responsible_user_amo_id,
    days_inactive: parseFloat(r.days_inactive),
    pipeline_amo_id: r.pipeline_amo_id,
    stage_amo_id: r.stage_amo_id,
  }));
}

export async function getActiveAlerts(accountId: string) {
  return db.query.bottleneckAlerts.findMany({
    where: and(
      eq(bottleneckAlerts.accountId, accountId),
      isNull(bottleneckAlerts.resolvedAt)
    ),
    orderBy: (t, { desc }) => desc(t.createdAt),
    limit: 100,
  });
}
