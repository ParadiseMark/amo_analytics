/**
 * Executes tool calls requested by the AI model.
 * Each handler resolves names → IDs using context, queries data, and returns a
 * plain-text or JSON string that gets injected back into the conversation.
 */
import { query } from "../lib/clickhouse/index.js";
import { db } from "../lib/db/index.js";
import { deals, notes, calls as callsTable, tasks, contacts, users } from "../lib/db/schema.js";
import { and, eq, ilike, or, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getStuckDeals, getActiveAlerts } from "../analytics/bottlenecks.service.js";
import { getManagerProfile } from "../analytics/profiles.service.js";
import type { AssistantContext } from "./context.js";

// ─── Name resolution helpers ──────────────────────────────────────────────────

function resolveManager(ctx: AssistantContext, name: string): number | null {
  if (!name || name.toLowerCase() === "all") return null;
  return ctx.managersByName.get(name.toLowerCase()) ?? null;
}

function resolvePipeline(ctx: AssistantContext, name: string): number | null {
  if (!name) return null;
  return ctx.pipelinesByName.get(name.toLowerCase()) ?? null;
}

// ─── Tool implementations ─────────────────────────────────────────────────────

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  switch (toolName) {
    case "get_manager_kpis":
      return getManagerKpis(args, ctx);
    case "get_manager_vs_plan":
      return getManagerVsPlan(args, ctx);
    case "get_manager_profile":
      return getManagerProfileTool(args, ctx);
    case "get_stuck_deals":
      return getStuckDealsTool(args, ctx);
    case "get_recommendations":
      return getRecommendations(args, ctx);
    case "list_managers_ranked":
      return listManagersRanked(args, ctx);
    case "get_pipeline_funnel":
      return getPipelineFunnel(args, ctx);
    case "get_bottleneck_stages":
      return getBottleneckStages(args, ctx);
    case "compare_managers":
      return compareManagers(args, ctx);
    case "search_deals_semantic":
      return searchDealsSemantic(args, ctx);
    case "get_deal_details":
      return getDealDetails(args, ctx);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ─── Individual handlers ──────────────────────────────────────────────────────

async function getManagerKpis(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const managerId = resolveManager(ctx, args.manager_name as string);
  const days = args.period === "7d" ? 7 : args.period === "90d" ? 90 : 30;
  const managerFilter = managerId != null ? `AND user_amo_id = {managerId: UInt32}` : "";

  type KpiRow = {
    user_amo_id: number;
    revenue_won: number;
    deals_won: number;
    deals_lost: number;
    win_rate: number;
    calls_made: number;
    tasks_completed: number;
    notes_added: number;
    response_time_p50: number;
    deal_velocity_avg: number;
  };

  const rows = await query<KpiRow>(`
    SELECT
      user_amo_id,
      sum(revenue_won)       AS revenue_won,
      sum(deals_won)         AS deals_won,
      sum(deals_lost)        AS deals_lost,
      avg(win_rate)          AS win_rate,
      sum(calls_made)        AS calls_made,
      sum(tasks_completed)   AS tasks_completed,
      sum(notes_added)       AS notes_added,
      avg(response_time_p50) AS response_time_p50,
      avg(deal_velocity_avg) AS deal_velocity_avg
    FROM daily_manager_kpis FINAL
    WHERE
      account_id = {accountId: String}
      AND date >= today() - {days: UInt16}
      ${managerFilter}
    GROUP BY user_amo_id
    ORDER BY revenue_won DESC
  `, { accountId: ctx.accountId, days, ...(managerId != null ? { managerId } : {}) });

  const result = rows.map((r) => ({
    manager: ctx.managersById.get(r.user_amo_id) ?? `Manager #${r.user_amo_id}`,
    revenue_won: Math.round(r.revenue_won),
    deals_won: r.deals_won,
    deals_lost: r.deals_lost,
    win_rate_pct: Math.round(r.win_rate * 100),
    calls_made: r.calls_made,
    tasks_completed: r.tasks_completed,
    notes_added: r.notes_added,
    response_time_p50_min: Math.round(r.response_time_p50),
    deal_velocity_days: Math.round(r.deal_velocity_avg),
  }));

  return JSON.stringify({ period_days: days, kpis: result });
}

async function getManagerVsPlan(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const managerId = resolveManager(ctx, args.manager_name as string);
  if (!managerId) return JSON.stringify({ error: "Manager not found" });

  const days = args.period === "7d" ? 7 : args.period === "90d" ? 90 : 30;
  const plan: number = ctx.planTargets[String(managerId)] ?? 0;

  type KpiRow = { revenue_won: number };
  const [row] = await query<KpiRow>(`
    SELECT sum(revenue_won) AS revenue_won
    FROM daily_manager_kpis FINAL
    WHERE account_id = {accountId: String}
      AND user_amo_id = {managerId: UInt32}
      AND date >= today() - {days: UInt16}
  `, { accountId: ctx.accountId, managerId, days });

  const actual = row?.revenue_won ?? 0;
  const gap = plan - actual;
  const pct = plan > 0 ? (actual / plan) * 100 : null;

  return JSON.stringify({
    manager: ctx.managersById.get(managerId),
    period_days: days,
    revenue_actual: Math.round(actual),
    revenue_plan: plan,
    gap: Math.round(gap),
    completion_pct: pct !== null ? Math.round(pct) : null,
  });
}

async function getManagerProfileTool(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const managerId = resolveManager(ctx, args.manager_name as string);
  if (!managerId) return JSON.stringify({ error: "Manager not found" });

  const profile = await getManagerProfile(ctx.accountId, managerId);
  if (!profile) return JSON.stringify({ error: "No profile data available yet" });

  return JSON.stringify({
    manager: ctx.managersById.get(managerId),
    percentiles: {
      revenue: profile.percentile_revenue,
      win_rate: profile.percentile_win_rate,
      response_time: profile.percentile_response,
      calls: profile.percentile_calls,
    },
    strengths: profile.profile.strengths,
    weaknesses: profile.profile.weaknesses,
    trend: profile.profile.trend,
    kpis_30d: {
      revenue: Math.round(profile.revenue_30d),
      win_rate_pct: Math.round(profile.win_rate_30d * 100),
      deals_won: profile.deals_won_30d,
      calls_made: profile.calls_made_30d,
      response_time_p50_min: Math.round(profile.response_time_30d),
    },
  });
}

async function getStuckDealsTool(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const managerId = args.manager_name
    ? resolveManager(ctx, args.manager_name as string) ?? undefined
    : undefined;
  const limit = (args.limit as number) ?? 20;

  const stuckDeals = await getStuckDeals(ctx.accountId, managerId, limit);
  const result = stuckDeals.map((d) => ({
    deal_id: d.amo_id,
    name: d.name,
    price: d.price,
    manager: ctx.managersById.get(d.responsible_user_amo_id) ?? `Manager #${d.responsible_user_amo_id}`,
    pipeline: ctx.pipelinesById.get(d.pipeline_amo_id) ?? `Pipeline #${d.pipeline_amo_id}`,
    stage: ctx.stagesById.get(d.stage_amo_id) ?? `Stage #${d.stage_amo_id}`,
    days_inactive: Math.round(d.days_inactive),
  }));

  return JSON.stringify({ stuck_deals: result });
}

async function getRecommendations(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const managerId = resolveManager(ctx, args.manager_name as string);
  if (!managerId) return JSON.stringify({ error: "Manager not found" });

  const profile = await getManagerProfile(ctx.accountId, managerId);
  if (!profile) return JSON.stringify({ error: "No profile data available" });

  const recommendations: string[] = [];
  const w = profile.profile.weaknesses;

  if (w.includes("low_win_rate")) {
    recommendations.push(
      "Focus on deal qualification — review the stages where most deals are lost and work on objection handling."
    );
  }
  if (w.includes("slow_response_time")) {
    recommendations.push(
      "Improve first response speed — aim to contact new leads within 30 minutes of creation."
    );
  }
  if (w.includes("low_call_rate")) {
    recommendations.push(
      "Increase calling activity — the team average is higher. Try to make at least 5 more calls per day."
    );
  }
  if (w.includes("low_revenue")) {
    recommendations.push(
      "Revenue is below average. Focus on deals with larger average value or increase the number of closed deals."
    );
  }
  if (w.includes("declining_trend")) {
    recommendations.push(
      "Revenue is on a declining trend. Review the pipeline for deals at risk and prioritise follow-ups."
    );
  }

  const s = profile.profile.strengths;
  const positives: string[] = [];
  if (s.includes("high_win_rate")) positives.push("excellent win rate");
  if (s.includes("fast_response_time")) positives.push("fast response to new leads");
  if (s.includes("high_call_rate")) positives.push("high call activity");
  if (s.includes("improving_trend")) positives.push("improving revenue trend");

  return JSON.stringify({
    manager: ctx.managersById.get(managerId),
    strengths_summary: positives.length > 0 ? positives : ["No standout strengths detected yet"],
    recommendations: recommendations.length > 0
      ? recommendations
      : ["Performance is solid across all tracked metrics. Keep it up!"],
  });
}

async function listManagersRanked(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const days = args.period === "7d" ? 7 : args.period === "90d" ? 90 : 30;
  const metric = (args.metric as string) ?? "revenue_won";
  const limit = (args.limit as number) ?? 10;

  const allowedMetrics = [
    "revenue_won", "win_rate", "calls_made", "deals_won", "response_time_p50",
  ];
  if (!allowedMetrics.includes(metric)) {
    return JSON.stringify({ error: `Invalid metric: ${metric}` });
  }

  const aggFn = ["win_rate", "response_time_p50"].includes(metric) ? "avg" : "sum";

  type RankRow = { user_amo_id: number; value: number };
  const rows = await query<RankRow>(`
    SELECT
      user_amo_id,
      ${aggFn}(${metric}) AS value
    FROM daily_manager_kpis FINAL
    WHERE
      account_id = {accountId: String}
      AND date >= today() - {days: UInt16}
    GROUP BY user_amo_id
    ORDER BY value ${metric === "response_time_p50" ? "ASC" : "DESC"}
    LIMIT {limit: UInt16}
  `, { accountId: ctx.accountId, days, limit });

  const ranked = rows.map((r, i) => ({
    rank: i + 1,
    manager: ctx.managersById.get(r.user_amo_id) ?? `Manager #${r.user_amo_id}`,
    [metric]: metric === "win_rate" ? Math.round(r.value * 100) + "%" : Math.round(r.value),
  }));

  return JSON.stringify({ period_days: days, metric, ranked });
}

async function getPipelineFunnel(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const pipelineId = resolvePipeline(ctx, args.pipeline_name as string);
  if (!pipelineId) return JSON.stringify({ error: "Pipeline not found" });

  const days = args.period === "7d" ? 7 : args.period === "90d" ? 90 : 30;
  const managerId = args.manager_name
    ? resolveManager(ctx, args.manager_name as string)
    : null;
  const managerFilter = managerId != null ? `AND user_amo_id = {managerId: UInt32}` : "";

  type TransRow = {
    from_stage_amo_id: number;
    to_stage_amo_id: number;
    transition_count: number;
    avg_time_hours: number;
  };

  const rows = await query<TransRow>(`
    SELECT
      from_stage_amo_id,
      to_stage_amo_id,
      sum(transition_count) AS transition_count,
      avg(avg_time_hours)   AS avg_time_hours
    FROM funnel_transitions FINAL
    WHERE
      account_id       = {accountId: String}
      AND pipeline_amo_id  = {pipelineId: UInt32}
      AND date >= today() - {days: UInt16}
      ${managerFilter}
    GROUP BY from_stage_amo_id, to_stage_amo_id
    ORDER BY from_stage_amo_id
  `, { accountId: ctx.accountId, pipelineId, days, ...(managerId != null ? { managerId } : {}) });

  const transitions = rows.map((r) => ({
    from_stage: ctx.stagesById.get(r.from_stage_amo_id) ?? `Stage #${r.from_stage_amo_id}`,
    to_stage: ctx.stagesById.get(r.to_stage_amo_id) ?? `Stage #${r.to_stage_amo_id}`,
    count: r.transition_count,
    avg_time_hours: Math.round(r.avg_time_hours * 10) / 10,
  }));

  return JSON.stringify({
    pipeline: ctx.pipelinesById.get(pipelineId),
    period_days: days,
    transitions,
  });
}

async function getBottleneckStages(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const alerts = await getActiveAlerts(ctx.accountId);
  const stageAlerts = alerts.filter((a) => a.alertType === "stage_bottleneck");

  const result = stageAlerts.map((a) => {
    const data = a.data as Record<string, unknown>;
    return {
      stage: ctx.stagesById.get(a.entityAmoId) ?? `Stage #${a.entityAmoId}`,
      pipeline: ctx.pipelinesById.get(data.pipeline_amo_id as number) ?? `Pipeline #${data.pipeline_amo_id}`,
      avg_hours: Math.round((data.avg_hours as number) * 10) / 10,
      account_avg_hours: Math.round((data.account_avg_hours as number) * 10) / 10,
      multiplier: Math.round((data.multiplier as number) * 10) / 10,
      severity: a.severity,
    };
  });

  return JSON.stringify({
    bottleneck_stages: result.length > 0 ? result : "No bottleneck stages detected currently.",
  });
}

async function compareManagers(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const names = args.manager_names as string[];
  const ids = names.map((n) => resolveManager(ctx, n)).filter((id): id is number => id !== null);
  if (ids.length < 2) return JSON.stringify({ error: "Could not resolve at least 2 managers" });

  const days = args.period === "7d" ? 7 : args.period === "90d" ? 90 : 30;

  type CompRow = {
    user_amo_id: number;
    revenue_won: number;
    win_rate: number;
    calls_made: number;
    deals_won: number;
    response_time_p50: number;
    deal_velocity_avg: number;
  };

  const rows = await query<CompRow>(`
    SELECT
      user_amo_id,
      sum(revenue_won)       AS revenue_won,
      avg(win_rate)          AS win_rate,
      sum(calls_made)        AS calls_made,
      sum(deals_won)         AS deals_won,
      avg(response_time_p50) AS response_time_p50,
      avg(deal_velocity_avg) AS deal_velocity_avg
    FROM daily_manager_kpis FINAL
    WHERE
      account_id  = {accountId: String}
      AND user_amo_id IN ({ids: Array(UInt32)})
      AND date >= today() - {days: UInt16}
    GROUP BY user_amo_id
  `, { accountId: ctx.accountId, ids, days });

  const result = rows.map((r) => ({
    manager: ctx.managersById.get(r.user_amo_id) ?? `Manager #${r.user_amo_id}`,
    revenue_won: Math.round(r.revenue_won),
    win_rate_pct: Math.round(r.win_rate * 100),
    calls_made: r.calls_made,
    deals_won: r.deals_won,
    response_time_p50_min: Math.round(r.response_time_p50),
    deal_velocity_days: Math.round(r.deal_velocity_avg),
  }));

  return JSON.stringify({ period_days: days, comparison: result });
}

async function searchDealsSemantic(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const searchQuery = args.query as string;
  const limit = (args.limit as number) ?? 10;
  const managerId = args.manager_name
    ? resolveManager(ctx, args.manager_name as string)
    : null;

  const managerClause = managerId != null
    ? sql`AND d.responsible_user_amo_id = ${managerId}`
    : sql``;

  let rows: { amo_id: number; name: string; price: string; responsible_user_amo_id: number; pipeline_amo_id: number; stage_amo_id: number }[];

  // Try vector search first (requires OPENAI_API_KEY and populated embeddings)
  try {
    const { env } = await import("../config/env.js");
    if (env.OPENAI_API_KEY) {
      // Embed the query
      const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: searchQuery, dimensions: 1536 }),
      });
      if (embedRes.ok) {
        const embedData = await embedRes.json() as { data: [{ embedding: number[] }] };
        const vec = `[${embedData.data[0].embedding.join(",")}]`;

        // Cosine similarity search — deals with embeddings first, fallback ILIKE for rest
        const vecResult = await db.execute<{
          amo_id: number; name: string; price: string;
          responsible_user_amo_id: number; pipeline_amo_id: number; stage_amo_id: number;
        }>(sql`
          SELECT d.amo_id, d.name, d.price::text,
                 d.responsible_user_amo_id, d.pipeline_amo_id, d.stage_amo_id
          FROM deals d
          WHERE d.account_id = ${ctx.accountId}
            AND d.is_deleted = false
            AND d.embedding IS NOT NULL
            ${managerClause}
          ORDER BY d.embedding <=> ${vec}::vector
          LIMIT ${limit}
        `);
        rows = vecResult.rows as typeof rows;
      } else {
        throw new Error("OpenAI API unavailable");
      }
    } else {
      throw new Error("No API key");
    }
  } catch {
    // Fallback: ILIKE keyword search
    const ilikeResult = await db.execute<{
      amo_id: number; name: string; price: string;
      responsible_user_amo_id: number; pipeline_amo_id: number; stage_amo_id: number;
    }>(sql`
      SELECT d.amo_id, d.name, d.price::text,
             d.responsible_user_amo_id, d.pipeline_amo_id, d.stage_amo_id
      FROM deals d
      WHERE d.account_id = ${ctx.accountId}
        AND d.is_deleted = false
        AND d.name ILIKE ${'%' + searchQuery + '%'}
        ${managerClause}
      LIMIT ${limit}
    `);
    rows = ilikeResult.rows as typeof rows;
  }

  const result = rows.map((d) => ({
    deal_id: d.amo_id,
    name: d.name,
    price: Number(d.price),
    manager: ctx.managersById.get(d.responsible_user_amo_id) ?? `Manager #${d.responsible_user_amo_id}`,
    pipeline: ctx.pipelinesById.get(d.pipeline_amo_id) ?? `Pipeline #${d.pipeline_amo_id}`,
    stage: ctx.stagesById.get(d.stage_amo_id) ?? `Stage #${d.stage_amo_id}`,
  }));

  return JSON.stringify({ query: searchQuery, results: result });
}

async function getDealDetails(
  args: Record<string, unknown>,
  ctx: AssistantContext
): Promise<string> {
  const { deal_name, deal_amo_id } = args as { deal_name?: string; deal_amo_id?: number };

  if (!deal_name && !deal_amo_id) {
    return JSON.stringify({ error: "Provide deal_name or deal_amo_id" });
  }

  const deal = await db.query.deals.findFirst({
    where: and(
      eq(deals.accountId, ctx.accountId),
      deal_amo_id != null
        ? eq(deals.amoId, deal_amo_id)
        : ilike(deals.name, `%${deal_name}%`)
    ),
  });

  if (!deal) return JSON.stringify({ error: "Deal not found" });

  // Fetch related data in parallel
  const [dealNotes, dealCalls, dealTasks] = await Promise.all([
    db.query.notes.findMany({
      where: and(
        eq(notes.accountId, ctx.accountId),
        eq(notes.entityAmoId, deal.amoId)
      ),
      orderBy: [desc(notes.createdAt)],
      limit: 10,
    }),
    db.query.calls.findMany({
      where: and(
        eq(callsTable.accountId, ctx.accountId),
        eq(callsTable.entityAmoId, deal.amoId)
      ),
      orderBy: [desc(callsTable.createdAt)],
      limit: 5,
    }),
    db.query.tasks.findMany({
      where: and(
        eq(tasks.accountId, ctx.accountId),
        eq(tasks.entityAmoId, deal.amoId)
      ),
      orderBy: [desc(tasks.createdAt)],
      limit: 10,
    }),
  ]);

  return JSON.stringify({
    deal: {
      id: deal.amoId,
      name: deal.name,
      price: deal.price,
      manager: ctx.managersById.get(deal.responsibleUserAmoId) ?? `Manager #${deal.responsibleUserAmoId}`,
      pipeline: ctx.pipelinesById.get(deal.pipelineAmoId) ?? `Pipeline #${deal.pipelineAmoId}`,
      stage: ctx.stagesById.get(deal.stageAmoId) ?? `Stage #${deal.stageAmoId}`,
      status: deal.closedStatus === 1 ? "won" : deal.closedStatus === 2 ? "lost" : "open",
      created_at: deal.createdAt,
      updated_at: deal.updatedAt,
      tags: deal.tags,
    },
    notes: dealNotes.map((n) => ({ date: n.createdAt, text: n.content })),
    calls: dealCalls.map((c) => ({
      date: c.createdAt,
      direction: c.direction,
      duration_sec: c.durationSeconds,
      status: c.callStatus,
    })),
    tasks: dealTasks.map((t) => ({
      text: t.text,
      due: t.completeTill,
      completed: t.isCompleted,
    })),
  });
}
