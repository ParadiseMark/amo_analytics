/**
 * Analytics REST API routes.
 *
 * All routes are scoped to a specific account and require a valid JWT.
 * Middleware verifies the requesting user has access to the accountId.
 *
 * Prefix: /api/v1/analytics/:accountId
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../../lib/clickhouse/index.js";
import { getStuckDeals, getActiveAlerts } from "../../analytics/bottlenecks.service.js";
import { getManagerProfile } from "../../analytics/profiles.service.js";
import { db } from "../../lib/db/index.js";
import { platformUserAccounts } from "../../lib/db/schema.js";
import { and, eq } from "drizzle-orm";
import { setAccountContext } from "../../lib/db/rls.js";

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function verifyAccountAccess(
  req: FastifyRequest<{ Params: { accountId: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const userId: string = (req.user as { sub: string }).sub;
  const { accountId } = req.params;

  const access = await db.query.platformUserAccounts.findFirst({
    where: and(
      eq(platformUserAccounts.platformUserId, userId),
      eq(platformUserAccounts.accountId, accountId)
    ),
  });

  if (!access) {
    return reply.code(403).send({ error: "Forbidden" });
  }

  // Set PostgreSQL RLS context for all subsequent queries in this request
  await setAccountContext(accountId, userId);
}

// ─── Route registration ───────────────────────────────────────────────────────

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // Apply account access check to all routes in this plugin
  app.addHook("preHandler", verifyAccountAccess);

  // ── GET /kpis ──────────────────────────────────────────────────────────────
  // Query params: period (7d|30d|90d), managerId (optional), pipelineId (optional)
  app.get("/:accountId/kpis", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const {
      period = "30d",
      managerId,
      pipelineId,
    } = req.query as { period?: string; managerId?: string; pipelineId?: string };

    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    type KpiRow = {
      user_amo_id: number;
      revenue_won: number;
      deals_won: number;
      deals_lost: number;
      deals_created: number;
      win_rate: number;
      calls_made: number;
      calls_answered: number;
      tasks_completed: number;
      tasks_overdue: number;
      notes_added: number;
      response_time_p50: number;
      deal_velocity_avg: number;
      avg_deal_value: number;
    };

    const managerFilter = managerId ? `AND user_amo_id = {managerId: UInt32}` : "";

    const rows = await query<KpiRow>(`
      SELECT
        user_amo_id,
        sum(revenue_won)       AS revenue_won,
        sum(deals_won)         AS deals_won,
        sum(deals_lost)        AS deals_lost,
        sum(deals_created)     AS deals_created,
        avg(win_rate)          AS win_rate,
        sum(calls_made)        AS calls_made,
        sum(calls_answered)    AS calls_answered,
        sum(tasks_completed)   AS tasks_completed,
        sum(tasks_overdue)     AS tasks_overdue,
        sum(notes_added)       AS notes_added,
        avg(response_time_p50) AS response_time_p50,
        avg(deal_velocity_avg) AS deal_velocity_avg,
        avg(avg_deal_value)    AS avg_deal_value
      FROM daily_manager_kpis FINAL
      WHERE
        account_id = {accountId: String}
        AND date >= today() - {days: UInt16}
        ${managerFilter}
      GROUP BY user_amo_id
      ORDER BY revenue_won DESC
    `, { accountId, days, ...(managerId ? { managerId: Number(managerId) } : {}) });

    // Also fetch previous period for trend deltas
    const prevRows = await query<KpiRow>(`
      SELECT
        user_amo_id,
        sum(revenue_won) AS revenue_won,
        avg(win_rate)    AS win_rate,
        sum(deals_won)   AS deals_won
      FROM daily_manager_kpis FINAL
      WHERE
        account_id = {accountId: String}
        AND date >= today() - {doubleDays: UInt16}
        AND date <  today() - {days: UInt16}
        ${managerFilter}
      GROUP BY user_amo_id
    `, { accountId, days, doubleDays: days * 2, ...(managerId ? { managerId: Number(managerId) } : {}) });

    const prevMap = new Map(prevRows.map((r) => [r.user_amo_id, r]));

    const result = rows.map((r) => {
      const prev = prevMap.get(r.user_amo_id);
      return {
        ...r,
        revenue_delta_pct: prev?.revenue_won
          ? ((r.revenue_won - prev.revenue_won) / prev.revenue_won) * 100
          : null,
        win_rate_delta: prev ? r.win_rate - prev.win_rate : null,
        deals_won_delta: prev ? r.deals_won - prev.deals_won : null,
      };
    });

    return reply.send({ period, days, data: result });
  });

  // ── GET /funnel ────────────────────────────────────────────────────────────
  // Query params: pipelineId (required), period (7d|30d|90d), managerId (optional)
  app.get("/:accountId/funnel", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const {
      pipelineId,
      period = "30d",
      managerId,
    } = req.query as { pipelineId?: string; period?: string; managerId?: string };

    if (!pipelineId) {
      return reply.code(400).send({ error: "pipelineId is required" });
    }

    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
    const managerFilter = managerId ? `AND user_amo_id = {managerId: UInt32}` : "";

    type TransitionRow = {
      from_stage_amo_id: number;
      to_stage_amo_id: number;
      transition_count: number;
      avg_time_hours: number;
      revenue_sum: number;
    };

    const rows = await query<TransitionRow>(`
      SELECT
        from_stage_amo_id,
        to_stage_amo_id,
        sum(transition_count) AS transition_count,
        avg(avg_time_hours)   AS avg_time_hours,
        sum(revenue_sum)      AS revenue_sum
      FROM funnel_transitions FINAL
      WHERE
        account_id    = {accountId: String}
        AND pipeline_amo_id = {pipelineId: UInt32}
        AND date >= today() - {days: UInt16}
        ${managerFilter}
      GROUP BY from_stage_amo_id, to_stage_amo_id
      ORDER BY from_stage_amo_id, to_stage_amo_id
    `, {
      accountId,
      pipelineId: Number(pipelineId),
      days,
      ...(managerId ? { managerId: Number(managerId) } : {}),
    });

    // Also fetch stage time data for bottleneck info
    type StageTimeRow = {
      stage_amo_id: number;
      avg_hours: number;
      p50_hours: number;
      p90_hours: number;
    };

    const stageTimes = await query<StageTimeRow>(`
      SELECT
        stage_amo_id,
        avg(duration_hours)                            AS avg_hours,
        quantile(0.5)(duration_hours)                  AS p50_hours,
        quantile(0.9)(duration_hours)                  AS p90_hours
      FROM deal_stage_time
      WHERE
        account_id      = {accountId: String}
        AND pipeline_amo_id = {pipelineId: UInt32}
        AND entered_at  >= now() - INTERVAL {days: UInt16} DAY
      GROUP BY stage_amo_id
      ORDER BY stage_amo_id
    `, { accountId, pipelineId: Number(pipelineId), days });

    return reply.send({ period, days, transitions: rows, stageTimes });
  });

  // ── GET /managers ──────────────────────────────────────────────────────────
  // Returns ranked list with latest profile data
  app.get("/:accountId/managers", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const { period = "30d" } = req.query as { period?: string };
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    type RankedRow = {
      user_amo_id: number;
      revenue_won: number;
      win_rate: number;
      deals_won: number;
      calls_made: number;
      response_time_p50: number;
      deal_velocity_avg: number;
      percentile_revenue: number;
      percentile_win_rate: number;
      profile_json: string;
    };

    const rows = await query<RankedRow>(`
      WITH kpis AS (
        SELECT
          user_amo_id,
          sum(revenue_won)       AS revenue_won,
          avg(win_rate)          AS win_rate,
          sum(deals_won)         AS deals_won,
          sum(calls_made)        AS calls_made,
          avg(response_time_p50) AS response_time_p50,
          avg(deal_velocity_avg) AS deal_velocity_avg
        FROM daily_manager_kpis FINAL
        WHERE
          account_id = {accountId: String}
          AND date >= today() - {days: UInt16}
        GROUP BY user_amo_id
      ),
      profiles AS (
        SELECT
          user_amo_id,
          percentile_revenue,
          percentile_win_rate,
          profile_json
        FROM manager_profiles FINAL
        WHERE account_id = {accountId: String}
        ORDER BY (account_id, user_amo_id, snapshot_week) DESC
        LIMIT 1 BY user_amo_id
      )
      SELECT
        k.user_amo_id,
        k.revenue_won,
        k.win_rate,
        k.deals_won,
        k.calls_made,
        k.response_time_p50,
        k.deal_velocity_avg,
        coalesce(p.percentile_revenue, 0) AS percentile_revenue,
        coalesce(p.percentile_win_rate, 0) AS percentile_win_rate,
        coalesce(p.profile_json, '{}')     AS profile_json
      FROM kpis k
      LEFT JOIN profiles p USING (user_amo_id)
      ORDER BY k.revenue_won DESC
    `, { accountId, days });

    const result = rows.map((r) => ({
      ...r,
      profile: (() => {
        try { return JSON.parse(r.profile_json); } catch { return {}; }
      })(),
    }));

    return reply.send({ period, days, managers: result });
  });

  // ── GET /managers/:userId ──────────────────────────────────────────────────
  app.get("/:accountId/managers/:userId", async (req, reply) => {
    const { accountId, userId } = req.params as { accountId: string; userId: string };
    const { period = "30d" } = req.query as { period?: string };
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
    const userAmoId = Number(userId);

    // Daily time series for trend charts
    type DailyRow = {
      date: string;
      revenue_won: number;
      deals_won: number;
      win_rate: number;
      calls_made: number;
      response_time_p50: number;
    };

    const [dailyRows, profile] = await Promise.all([
      query<DailyRow>(`
        SELECT
          date,
          revenue_won,
          deals_won,
          win_rate,
          calls_made,
          response_time_p50
        FROM daily_manager_kpis FINAL
        WHERE
          account_id  = {accountId: String}
          AND user_amo_id = {userAmoId: UInt32}
          AND date >= today() - {days: UInt16}
        ORDER BY date
      `, { accountId, userAmoId, days }),
      getManagerProfile(accountId, userAmoId),
    ]);

    const stuckDeals = await getStuckDeals(accountId, userAmoId, 20);

    return reply.send({
      userAmoId,
      period,
      days,
      timeSeries: dailyRows,
      profile,
      stuckDeals,
    });
  });

  // ── GET /deals/stuck ──────────────────────────────────────────────────────
  app.get("/:accountId/deals/stuck", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const { managerId, limit = "50" } = req.query as { managerId?: string; limit?: string };

    const deals = await getStuckDeals(
      accountId,
      managerId ? Number(managerId) : undefined,
      Number(limit)
    );

    return reply.send({ deals });
  });

  // ── GET /bottlenecks ──────────────────────────────────────────────────────
  app.get("/:accountId/bottlenecks", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const alerts = await getActiveAlerts(accountId);
    return reply.send({ alerts });
  });

  // ── GET /sparklines ───────────────────────────────────────────────────────
  // Daily aggregates for sparklines on the overview KPI cards
  app.get("/:accountId/sparklines", async (req, reply) => {
    await verifyAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply
    );

    const { accountId } = req.params as { accountId: string };
    const { days: daysStr = "14" } = req.query as { days?: string };
    const days = Math.min(Math.max(Number(daysStr) || 14, 7), 90);

    type SparkRow = {
      date: string;
      total_revenue: number;
      total_deals_won: number;
      total_calls_made: number;
      avg_win_rate: number;
    };

    const rows = await query<SparkRow>(`
      SELECT
        date,
        sum(revenue_won)  AS total_revenue,
        sum(deals_won)    AS total_deals_won,
        sum(calls_made)   AS total_calls_made,
        avg(win_rate)     AS avg_win_rate
      FROM daily_manager_kpis FINAL
      WHERE
        account_id = {accountId: String}
        AND date >= today() - {days: UInt16}
      GROUP BY date
      ORDER BY date
    `, { accountId, days });

    return reply.send({ data: rows });
  });

  // ── GET /heatmap ──────────────────────────────────────────────────────────
  // Stage × Manager heatmap: avg days in each stage per manager
  app.get("/:accountId/heatmap", async (req, reply) => {
    await verifyAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply
    );

    const { accountId } = req.params as { accountId: string };
    const { pipelineId, period = "30d" } = req.query as { pipelineId?: string; period?: string };
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    if (!pipelineId) return reply.code(400).send({ error: "pipelineId required" });
    const pipelineAmoId = Number(pipelineId);

    type HeatmapRow = {
      user_amo_id: number;
      stage_amo_id: number;
      avg_hours: number;
      deal_count: number;
    };

    const rows = await query<HeatmapRow>(`
      SELECT
        user_amo_id,
        to_stage_amo_id   AS stage_amo_id,
        avg(avg_time_hours) AS avg_hours,
        sum(transition_count) AS deal_count
      FROM funnel_transitions FINAL
      WHERE
        account_id     = {accountId: String}
        AND pipeline_amo_id = {pipelineAmoId: UInt32}
        AND date        >= today() - {days: UInt16}
        AND user_amo_id != 0
      GROUP BY user_amo_id, stage_amo_id
      ORDER BY user_amo_id, stage_amo_id
    `, { accountId, pipelineAmoId, days });

    // Derive unique managers and stages for client-side rendering
    const managers = [...new Set(rows.map((r) => r.user_amo_id))];
    const stages = [...new Set(rows.map((r) => r.stage_amo_id))];

    return reply.send({ rows, managers, stages });
  });

  // ── GET /overview ─────────────────────────────────────────────────────────
  // Top-level dashboard summary: totals + top/bottom performers
  app.get("/:accountId/overview", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const { period = "30d" } = req.query as { period?: string };
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    type SummaryRow = {
      total_revenue: number;
      total_deals_won: number;
      total_deals_created: number;
      avg_win_rate: number;
      total_calls_made: number;
      active_managers: number;
    };

    const [summary, topManagers, bottleneckAlerts] = await Promise.all([
      query<SummaryRow>(`
        SELECT
          sum(revenue_won)     AS total_revenue,
          sum(deals_won)       AS total_deals_won,
          sum(deals_created)   AS total_deals_created,
          avg(win_rate)        AS avg_win_rate,
          sum(calls_made)      AS total_calls_made,
          uniq(user_amo_id)    AS active_managers
        FROM daily_manager_kpis FINAL
        WHERE
          account_id = {accountId: String}
          AND date >= today() - {days: UInt16}
      `, { accountId, days }),

      query<{ user_amo_id: number; revenue_won: number; win_rate: number }>(`
        SELECT
          user_amo_id,
          sum(revenue_won) AS revenue_won,
          avg(win_rate)    AS win_rate
        FROM daily_manager_kpis FINAL
        WHERE
          account_id = {accountId: String}
          AND date >= today() - {days: UInt16}
        GROUP BY user_amo_id
        ORDER BY revenue_won DESC
        LIMIT 5
      `, { accountId, days }),

      getActiveAlerts(accountId),
    ]);

    return reply.send({
      period,
      days,
      summary: summary[0] ?? null,
      topManagers,
      alertCount: bottleneckAlerts.length,
      criticalAlerts: bottleneckAlerts.filter((a) => a.severity === "critical").length,
    });
  });
}
