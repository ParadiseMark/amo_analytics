import { exec } from "./index.js";

/**
 * Creates all ClickHouse tables if they don't exist.
 * Run once at startup.
 */
export async function runClickHouseMigrations(): Promise<void> {
  // daily_manager_kpis — main analytics table
  // ReplacingMergeTree so recomputes overwrite previous rows
  await exec(`
    CREATE TABLE IF NOT EXISTS daily_manager_kpis (
      account_id        String,
      user_amo_id       Int32,
      date              Date,

      -- Volume metrics
      deals_created     Int32    DEFAULT 0,
      deals_won         Int32    DEFAULT 0,
      deals_lost        Int32    DEFAULT 0,
      revenue_won       Float64  DEFAULT 0,
      revenue_pipeline  Float64  DEFAULT 0,
      avg_deal_value    Float64  DEFAULT 0,
      win_rate          Float32  DEFAULT 0,   -- 0..1

      -- Activity metrics
      calls_made        Int32    DEFAULT 0,
      calls_answered    Int32    DEFAULT 0,   -- status 4
      avg_call_duration Float32  DEFAULT 0,  -- seconds
      tasks_created     Int32    DEFAULT 0,
      tasks_completed   Int32    DEFAULT 0,
      tasks_overdue     Int32    DEFAULT 0,
      notes_added       Int32    DEFAULT 0,

      -- Speed metrics
      response_time_p50 Float32  DEFAULT 0,  -- minutes, median
      response_time_p95 Float32  DEFAULT 0,  -- minutes, 95th pct
      deal_velocity_avg Float32  DEFAULT 0,  -- days created→won

      -- Updated timestamp for ReplacingMergeTree dedup
      updated_at        DateTime DEFAULT now()
    )
    ENGINE = ReplacingMergeTree(updated_at)
    PARTITION BY toYYYYMM(date)
    ORDER BY (account_id, user_amo_id, date)
    SETTINGS index_granularity = 8192
  `);

  // funnel_transitions — stage conversion analytics
  await exec(`
    CREATE TABLE IF NOT EXISTS funnel_transitions (
      account_id        String,
      pipeline_amo_id   Int32,
      from_stage_amo_id Int32,
      to_stage_amo_id   Int32,
      user_amo_id       Int32    DEFAULT 0,  -- 0 = all managers
      date              Date,

      transition_count  Int32    DEFAULT 0,
      avg_time_hours    Float32  DEFAULT 0,
      revenue_sum       Float64  DEFAULT 0,

      updated_at        DateTime DEFAULT now()
    )
    ENGINE = ReplacingMergeTree(updated_at)
    PARTITION BY toYYYYMM(date)
    ORDER BY (account_id, pipeline_amo_id, from_stage_amo_id, to_stage_amo_id, user_amo_id, date)
  `);

  // deal_stage_time — raw time-in-stage per deal (for percentile calcs)
  await exec(`
    CREATE TABLE IF NOT EXISTS deal_stage_time (
      account_id        String,
      deal_amo_id       Int32,
      pipeline_amo_id   Int32,
      stage_amo_id      Int32,
      user_amo_id       Int32,
      entered_at        DateTime,
      exited_at         DateTime,
      duration_hours    Float32,
      date              Date  -- date of entry (for partitioning)
    )
    ENGINE = ReplacingMergeTree()
    PARTITION BY toYYYYMM(date)
    ORDER BY (account_id, deal_amo_id, stage_amo_id, entered_at)
  `);

  // manager_profiles — weekly snapshots (for AI assistant context)
  await exec(`
    CREATE TABLE IF NOT EXISTS manager_profiles (
      account_id          String,
      user_amo_id         Int32,
      snapshot_week       Date,  -- Monday of the week

      -- Percentiles within the account
      percentile_revenue  Float32  DEFAULT 0,   -- 0..100
      percentile_win_rate Float32  DEFAULT 0,
      percentile_response Float32  DEFAULT 0,   -- lower is better
      percentile_calls    Float32  DEFAULT 0,

      -- 30-day KPI snapshot
      revenue_30d         Float64  DEFAULT 0,
      win_rate_30d        Float32  DEFAULT 0,
      deals_won_30d       Int32    DEFAULT 0,
      calls_made_30d      Int32    DEFAULT 0,
      response_time_30d   Float32  DEFAULT 0,

      -- Trend: slope of revenue over last 12 weeks (positive = improving)
      revenue_trend       Float32  DEFAULT 0,

      -- Serialized JSON: {strengths: [...], weaknesses: [...]}
      profile_json        String   DEFAULT '{}',

      updated_at          DateTime DEFAULT now()
    )
    ENGINE = ReplacingMergeTree(updated_at)
    ORDER BY (account_id, user_amo_id, snapshot_week)
  `);

  console.log("[clickhouse] Migrations applied");
}
