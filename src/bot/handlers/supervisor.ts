/**
 * Supervisor-role bot command handlers.
 */
import type { Context } from "grammy";
import type { BotSession } from "../types.js";
import { query } from "../../lib/clickhouse/index.js";
import { getActiveAlerts } from "../../analytics/bottlenecks.service.js";
import { buildAssistantContext } from "../../ai/context.js";
import { formatKpiReport, formatFunnel } from "../formatters.js";

export const supervisorHandlers = {
  async report(ctx: Context, session: BotSession): Promise<void> {
    const arg = (ctx.message as { text?: string })?.text?.split(" ")[1] ?? "30d";
    const period = ["7d", "30d", "90d"].includes(arg) ? arg : "30d";
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    type KpiRow = {
      user_amo_id: number;
      revenue_won: number;
      deals_won: number;
      win_rate: number;
      calls_made: number;
      response_time_p50: number;
    };

    const rows = await query<KpiRow>(`
      SELECT
        user_amo_id,
        sum(revenue_won)       AS revenue_won,
        sum(deals_won)         AS deals_won,
        avg(win_rate)          AS win_rate,
        sum(calls_made)        AS calls_made,
        avg(response_time_p50) AS response_time_p50
      FROM daily_manager_kpis FINAL
      WHERE account_id = {accountId: String}
        AND date >= today() - {days: UInt16}
      GROUP BY user_amo_id
      ORDER BY revenue_won DESC
      LIMIT 10
    `, { accountId: session.accountId, days });

    const ctx2 = await buildAssistantContext(session.accountId);

    const kpis = rows.map((r) => ({
      manager: ctx2.managersById.get(r.user_amo_id) ?? `Manager #${r.user_amo_id}`,
      revenue_won: Math.round(r.revenue_won),
      deals_won: r.deals_won,
      win_rate_pct: Math.round(r.win_rate * 100),
      calls_made: r.calls_made,
      response_time_p50_min: Math.round(r.response_time_p50),
    }));

    const alerts = await getActiveAlerts(session.accountId);
    const criticalCount = alerts.filter((a) => a.severity === "critical").length;

    let text = formatKpiReport(kpis, period);
    if (criticalCount > 0) {
      text += `\n\n⚠️ *${criticalCount} критических алерта* — введите /bottlenecks для деталей`;
    }

    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  },

  async funnel(ctx: Context, session: BotSession): Promise<void> {
    const assistCtx = await buildAssistantContext(session.accountId);

    // Use the first pipeline if none specified
    const pipelineName = (ctx.message as { text?: string })?.text?.split(" ").slice(1).join(" ");
    let pipelineId: number | null = null;
    let pipelineDisplayName = "основная воронка";

    if (pipelineName) {
      pipelineId = assistCtx.pipelinesByName.get(pipelineName.toLowerCase()) ?? null;
      pipelineDisplayName = pipelineName;
    } else {
      // Pick the first pipeline
      const first = assistCtx.pipelinesById.entries().next();
      if (!first.done) {
        pipelineId = first.value[0];
        pipelineDisplayName = first.value[1];
      }
    }

    if (!pipelineId) {
      await ctx.reply("Воронка не найдена. Укажите название: /funnel Основная");
      return;
    }

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
      WHERE account_id       = {accountId: String}
        AND pipeline_amo_id  = {pipelineId: UInt32}
        AND date >= today() - 30
      GROUP BY from_stage_amo_id, to_stage_amo_id
      ORDER BY from_stage_amo_id
    `, { accountId: session.accountId, pipelineId });

    const transitions = rows.map((r) => ({
      from_stage: assistCtx.stagesById.get(r.from_stage_amo_id) ?? `Stage #${r.from_stage_amo_id}`,
      to_stage: assistCtx.stagesById.get(r.to_stage_amo_id) ?? `Stage #${r.to_stage_amo_id}`,
      count: r.transition_count,
      avg_time_hours: Math.round(r.avg_time_hours * 10) / 10,
    }));

    await ctx.reply(formatFunnel(transitions, pipelineDisplayName), { parse_mode: "MarkdownV2" });
  },
};
