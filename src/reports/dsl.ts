/**
 * Report DSL — schema and type definitions.
 *
 * A report is stored as a JSON document in the report_definitions table.
 * The DSL is deliberately constrained to prevent SQL injection:
 *   - data_source is an allowlist
 *   - fields are allowlists per source
 *   - operators are enums
 *   - values are always parameterised
 */
import { z } from "zod";

// ─── Allowed data sources and their available fields ─────────────────────────

export const DATA_SOURCES = {
  daily_manager_kpis: [
    "user_amo_id",
    "date",
    "revenue_won",
    "revenue_pipeline",
    "deals_created",
    "deals_won",
    "deals_lost",
    "avg_deal_value",
    "win_rate",
    "calls_made",
    "calls_answered",
    "avg_call_duration",
    "tasks_created",
    "tasks_completed",
    "tasks_overdue",
    "notes_added",
    "response_time_p50",
    "response_time_p95",
    "deal_velocity_avg",
  ],
  funnel_transitions: [
    "pipeline_amo_id",
    "from_stage_amo_id",
    "to_stage_amo_id",
    "user_amo_id",
    "date",
    "transition_count",
    "avg_time_hours",
    "revenue_sum",
  ],
  deal_stage_time: [
    "pipeline_amo_id",
    "stage_amo_id",
    "user_amo_id",
    "duration_hours",
    "date",
  ],
} as const;

export type DataSource = keyof typeof DATA_SOURCES;

const DATA_SOURCE_NAMES = Object.keys(DATA_SOURCES) as [DataSource, ...DataSource[]];

// ─── Aggregation functions ────────────────────────────────────────────────────

export const AGG_FUNCTIONS = ["sum", "avg", "count", "min", "max", "uniq"] as const;
export type AggFunction = (typeof AGG_FUNCTIONS)[number];

// ─── Filter operators ─────────────────────────────────────────────────────────

const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in"] as const;
type FilterOp = (typeof FILTER_OPS)[number];

// ─── Chart types ──────────────────────────────────────────────────────────────

const CHART_TYPES = ["bar", "line", "pie", "table"] as const;

// ─── DSL Zod schema ───────────────────────────────────────────────────────────

export const ReportDslSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  data_source: z.enum(DATA_SOURCE_NAMES),
  filters: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(FILTER_OPS),
        // Value may be a string, number, boolean, array, or a "relative date" keyword
        value: z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.union([z.string(), z.number()])),
        ]),
      })
    )
    .default([]),
  group_by: z.array(z.string()).default([]),
  metrics: z.array(
    z.object({
      field: z.string(),
      agg: z.enum(AGG_FUNCTIONS),
      label: z.string().optional(),
    })
  ).min(1),
  order_by: z
    .array(
      z.object({
        field: z.string(),
        direction: z.enum(["asc", "desc"]).default("desc"),
      })
    )
    .default([]),
  limit: z.number().int().min(1).max(1000).default(100),
  chart: z
    .object({
      type: z.enum(CHART_TYPES),
      x_axis: z.string().optional(),
      y_axis: z.string().optional(),
    })
    .optional(),
  schedule: z
    .object({
      cron: z.string(), // e.g. "0 9 * * 1"
      recipients: z.array(z.string().email()),
    })
    .optional(),
});

export type ReportDsl = z.infer<typeof ReportDslSchema>;

// ─── Relative date resolution ─────────────────────────────────────────────────

const RELATIVE_DATES: Record<string, string> = {
  today: "today()",
  yesterday: "today() - 1",
  last_7_days:  "today() - 7",
  last_30_days: "today() - 30",
  last_90_days: "today() - 90",
  this_month:   "toStartOfMonth(today())",
  last_month:   "toStartOfMonth(today() - 32)",
};

export function resolveRelativeDate(value: string): string {
  return RELATIVE_DATES[value] ?? value;
}
