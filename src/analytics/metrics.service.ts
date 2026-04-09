/**
 * Metrics computation service.
 * Reads raw data from PostgreSQL, computes KPIs,
 * writes aggregated rows to ClickHouse.
 */
import { sql } from "drizzle-orm";
import { db } from "../lib/db/index.js";
import { insert, query } from "../lib/clickhouse/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DailyManagerKpi = {
  account_id: string;
  user_amo_id: number;
  date: string; // YYYY-MM-DD
  deals_created: number;
  deals_won: number;
  deals_lost: number;
  revenue_won: number;
  revenue_pipeline: number;
  avg_deal_value: number;
  win_rate: number;
  calls_made: number;
  calls_answered: number;
  avg_call_duration: number;
  tasks_created: number;
  tasks_completed: number;
  tasks_overdue: number;
  notes_added: number;
  response_time_p50: number;
  response_time_p95: number;
  deal_velocity_avg: number;
};

// ─── Main computation entry point ────────────────────────────────────────────

/**
 * Recompute KPIs for a given account, optionally scoped to a user and date range.
 * If userAmoId is undefined → recompute all managers.
 * If startDate/endDate are undefined → last 7 days.
 */
export async function computeManagerKpis(
  accountId: string,
  options: {
    userAmoId?: number;
    startDate?: string; // YYYY-MM-DD
    endDate?: string;
  } = {}
): Promise<void> {
  const endDate = options.endDate ?? formatDate(new Date());
  const startDate = options.startDate ?? formatDate(daysAgo(7));

  const rows = await computeKpiRows(accountId, options.userAmoId, startDate, endDate);
  if (rows.length > 0) {
    await insert("daily_manager_kpis", rows);
  }
  console.log(
    `[metrics] Wrote ${rows.length} KPI rows for account=${accountId} ` +
    `manager=${options.userAmoId ?? "all"} period=${startDate}..${endDate}`
  );
}

// ─── KPI row computation ──────────────────────────────────────────────────────

async function computeKpiRows(
  accountId: string,
  userAmoId: number | undefined,
  startDate: string,
  endDate: string
): Promise<DailyManagerKpi[]> {
  // Build SQL dynamically — scoped by user if provided
  const userFilter = userAmoId != null
    ? sql`AND d.responsible_user_amo_id = ${userAmoId}`
    : sql``;

  // ── Deals KPIs ────────────────────────────────────────────────────────────
  type DealRow = {
    user_amo_id: number;
    date: string;
    deals_created: string;
    deals_won: string;
    deals_lost: string;
    revenue_won: string;
    revenue_pipeline: string;
    avg_deal_value: string;
    win_rate: string;
    deal_velocity_avg: string;
  };

  const dealRows = await db.execute<DealRow>(sql`
    SELECT
      d.responsible_user_amo_id                                  AS user_amo_id,
      DATE(d.created_at AT TIME ZONE 'UTC')                      AS date,
      COUNT(*)                                                    AS deals_created,
      COUNT(*) FILTER (WHERE d.closed_status = 1)                AS deals_won,
      COUNT(*) FILTER (WHERE d.closed_status = 2)                AS deals_lost,
      COALESCE(SUM(d.price) FILTER (WHERE d.closed_status = 1), 0) AS revenue_won,
      COALESCE(SUM(d.price) FILTER (WHERE d.closed_status = 0), 0) AS revenue_pipeline,
      COALESCE(
        AVG(d.price::numeric) FILTER (WHERE d.closed_status = 1), 0
      )                                                          AS avg_deal_value,
      COALESCE(
        COUNT(*) FILTER (WHERE d.closed_status = 1)::float /
        NULLIF(COUNT(*) FILTER (WHERE d.closed_status IN (1,2)), 0),
        0
      )                                                          AS win_rate,
      COALESCE(
        AVG(
          EXTRACT(EPOCH FROM (d.closed_at - d.created_at)) / 86400.0
        ) FILTER (WHERE d.closed_status = 1 AND d.closed_at IS NOT NULL),
        0
      )                                                          AS deal_velocity_avg
    FROM deals d
    WHERE
      d.account_id = ${accountId}
      AND d.is_deleted = false
      AND d.created_at >= ${startDate}::date
      AND d.created_at <  ${endDate}::date + INTERVAL '1 day'
      AND d.responsible_user_amo_id IS NOT NULL
      ${userFilter}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);

  // ── Calls KPIs ────────────────────────────────────────────────────────────
  type CallRow = {
    user_amo_id: number;
    date: string;
    calls_made: string;
    calls_answered: string;
    avg_call_duration: string;
  };

  const callRows = await db.execute<CallRow>(sql`
    SELECT
      c.responsible_user_amo_id                              AS user_amo_id,
      DATE(c.created_at AT TIME ZONE 'UTC')                  AS date,
      COUNT(*)                                               AS calls_made,
      COUNT(*) FILTER (WHERE c.call_status = 4)              AS calls_answered,
      COALESCE(AVG(c.duration_seconds) FILTER (WHERE c.call_status = 4), 0) AS avg_call_duration
    FROM calls c
    WHERE
      c.account_id = ${accountId}
      AND c.created_at >= ${startDate}::date
      AND c.created_at <  ${endDate}::date + INTERVAL '1 day'
      AND c.responsible_user_amo_id IS NOT NULL
      ${userAmoId != null ? sql`AND c.responsible_user_amo_id = ${userAmoId}` : sql``}
    GROUP BY 1, 2
  `);

  // ── Tasks KPIs ────────────────────────────────────────────────────────────
  type TaskRow = {
    user_amo_id: number;
    date: string;
    tasks_created: string;
    tasks_completed: string;
    tasks_overdue: string;
  };

  const taskRows = await db.execute<TaskRow>(sql`
    SELECT
      t.responsible_user_amo_id                              AS user_amo_id,
      DATE(t.created_at AT TIME ZONE 'UTC')                  AS date,
      COUNT(*)                                               AS tasks_created,
      COUNT(*) FILTER (WHERE t.is_completed = true)          AS tasks_completed,
      COUNT(*) FILTER (
        WHERE t.is_completed = false
          AND t.complete_till < NOW()
      )                                                      AS tasks_overdue
    FROM tasks t
    WHERE
      t.account_id = ${accountId}
      AND t.created_at >= ${startDate}::date
      AND t.created_at <  ${endDate}::date + INTERVAL '1 day'
      AND t.responsible_user_amo_id IS NOT NULL
      ${userAmoId != null ? sql`AND t.responsible_user_amo_id = ${userAmoId}` : sql``}
    GROUP BY 1, 2
  `);

  // ── Notes KPIs ────────────────────────────────────────────────────────────
  type NoteRow = {
    user_amo_id: number;
    date: string;
    notes_added: string;
  };

  const noteRows = await db.execute<NoteRow>(sql`
    SELECT
      n.responsible_user_amo_id                              AS user_amo_id,
      DATE(n.created_at AT TIME ZONE 'UTC')                  AS date,
      COUNT(*)                                               AS notes_added
    FROM notes n
    WHERE
      n.account_id = ${accountId}
      AND n.created_at >= ${startDate}::date
      AND n.created_at <  ${endDate}::date + INTERVAL '1 day'
      AND n.responsible_user_amo_id IS NOT NULL
      ${userAmoId != null ? sql`AND n.responsible_user_amo_id = ${userAmoId}` : sql``}
    GROUP BY 1, 2
  `);

  // ── Response time (created → first note/call/task on the deal) ────────────
  type ResponseRow = {
    user_amo_id: number;
    date: string;
    p50_minutes: string;
    p95_minutes: string;
  };

  const responseRows = await db.execute<ResponseRow>(sql`
    WITH first_actions AS (
      SELECT
        d.responsible_user_amo_id,
        DATE(d.created_at AT TIME ZONE 'UTC') AS date,
        EXTRACT(EPOCH FROM (d.first_action_at - d.created_at)) / 60.0 AS response_minutes
      FROM deals d
      WHERE
        d.account_id = ${accountId}
        AND d.first_action_at IS NOT NULL
        AND d.created_at >= ${startDate}::date
        AND d.created_at <  ${endDate}::date + INTERVAL '1 day'
        AND d.responsible_user_amo_id IS NOT NULL
        ${userAmoId != null ? sql`AND d.responsible_user_amo_id = ${userAmoId}` : sql``}
    )
    SELECT
      responsible_user_amo_id                    AS user_amo_id,
      date,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_minutes) AS p50_minutes,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_minutes) AS p95_minutes
    FROM first_actions
    GROUP BY 1, 2
  `);

  // ── Merge all into KPI rows ───────────────────────────────────────────────

  // Build lookup maps keyed by "user_amo_id:date"
  const callMap = new Map(callRows.rows.map((r) => [`${r.user_amo_id}:${r.date}`, r]));
  const taskMap = new Map(taskRows.rows.map((r) => [`${r.user_amo_id}:${r.date}`, r]));
  const noteMap = new Map(noteRows.rows.map((r) => [`${r.user_amo_id}:${r.date}`, r]));
  const responseMap = new Map(responseRows.rows.map((r) => [`${r.user_amo_id}:${r.date}`, r]));

  const result: DailyManagerKpi[] = dealRows.rows.map((d) => {
    const key = `${d.user_amo_id}:${d.date}`;
    const c = callMap.get(key);
    const t = taskMap.get(key);
    const n = noteMap.get(key);
    const r = responseMap.get(key);

    return {
      account_id: accountId,
      user_amo_id: Number(d.user_amo_id),
      date: String(d.date).substring(0, 10),
      deals_created: Number(d.deals_created),
      deals_won: Number(d.deals_won),
      deals_lost: Number(d.deals_lost),
      revenue_won: Number(d.revenue_won),
      revenue_pipeline: Number(d.revenue_pipeline),
      avg_deal_value: Number(d.avg_deal_value),
      win_rate: Number(d.win_rate),
      deal_velocity_avg: Number(d.deal_velocity_avg),
      calls_made: Number(c?.calls_made ?? 0),
      calls_answered: Number(c?.calls_answered ?? 0),
      avg_call_duration: Number(c?.avg_call_duration ?? 0),
      tasks_created: Number(t?.tasks_created ?? 0),
      tasks_completed: Number(t?.tasks_completed ?? 0),
      tasks_overdue: Number(t?.tasks_overdue ?? 0),
      notes_added: Number(n?.notes_added ?? 0),
      response_time_p50: Number(r?.p50_minutes ?? 0),
      response_time_p95: Number(r?.p95_minutes ?? 0),
    };
  });

  return result;
}

// ─── Funnel transitions ───────────────────────────────────────────────────────

export async function computeFunnelTransitions(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<void> {
  type TransRow = {
    pipeline_amo_id: number;
    from_stage: number;
    to_stage: number;
    user_amo_id: number;
    date: string;
    cnt: string;
    avg_hours: string;
    rev_sum: string;
  };

  const rows = await db.execute<TransRow>(sql`
    WITH status_changes AS (
      SELECT
        d.pipeline_amo_id,
        d.responsible_user_amo_id                              AS user_amo_id,
        LAG(d.status_id) OVER (
          PARTITION BY d.account_id, d.amo_id ORDER BY e.occurred_at
        )                                                      AS from_stage,
        d.status_id                                            AS to_stage,
        e.occurred_at,
        d.price,
        DATE(e.occurred_at AT TIME ZONE 'UTC')                 AS date,
        LAG(e.occurred_at) OVER (
          PARTITION BY d.account_id, d.amo_id ORDER BY e.occurred_at
        )                                                      AS prev_time
      FROM deal_events e
      JOIN deals d ON d.account_id = e.account_id AND d.amo_id = e.deal_amo_id
      WHERE
        e.account_id = ${accountId}
        AND e.event_type = 'status_change'
        AND e.occurred_at >= ${startDate}::date
        AND e.occurred_at <  ${endDate}::date + INTERVAL '1 day'
    )
    SELECT
      pipeline_amo_id,
      from_stage,
      to_stage,
      user_amo_id,
      date,
      COUNT(*)                                                  AS cnt,
      AVG(EXTRACT(EPOCH FROM (occurred_at - prev_time)) / 3600.0)
        FILTER (WHERE prev_time IS NOT NULL)                    AS avg_hours,
      SUM(price)                                               AS rev_sum
    FROM status_changes
    WHERE from_stage IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5
  `);

  const chRows = rows.rows.map((r) => ({
    account_id: accountId,
    pipeline_amo_id: Number(r.pipeline_amo_id),
    from_stage_amo_id: Number(r.from_stage),
    to_stage_amo_id: Number(r.to_stage),
    user_amo_id: Number(r.user_amo_id),
    date: String(r.date).substring(0, 10),
    transition_count: Number(r.cnt),
    avg_time_hours: Number(r.avg_hours ?? 0),
    revenue_sum: Number(r.rev_sum ?? 0),
  }));

  if (chRows.length > 0) {
    await insert("funnel_transitions", chRows);
    console.log(`[metrics] Wrote ${chRows.length} funnel transition rows`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().substring(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
