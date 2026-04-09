/**
 * Manager-role bot command handlers.
 */
import type { Context } from "grammy";
import type { BotSession } from "../types.js";
import { db } from "../../lib/db/index.js";
import { deals, tasks } from "../../lib/db/schema.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { query } from "../../lib/clickhouse/index.js";
import { buildAssistantContext } from "../../ai/context.js";
import { formatDealsList, formatTasksList, formatCurrency, formatPct, md } from "../formatters.js";

export const managerHandlers = {
  async myStats(ctx: Context, session: BotSession): Promise<void> {
    if (!session.userAmoId) {
      await ctx.reply("Ваш аккаунт AmoCRM не привязан. Обратитесь к администратору.");
      return;
    }

    type KpiRow = {
      revenue_won: number;
      deals_won: number;
      deals_created: number;
      win_rate: number;
      calls_made: number;
      response_time_p50: number;
      deal_velocity_avg: number;
    };

    const [row] = await query<KpiRow>(`
      SELECT
        sum(revenue_won)       AS revenue_won,
        sum(deals_won)         AS deals_won,
        sum(deals_created)     AS deals_created,
        avg(win_rate)          AS win_rate,
        sum(calls_made)        AS calls_made,
        avg(response_time_p50) AS response_time_p50,
        avg(deal_velocity_avg) AS deal_velocity_avg
      FROM daily_manager_kpis FINAL
      WHERE account_id  = {accountId: String}
        AND user_amo_id = {userAmoId: UInt32}
        AND date >= today() - 30
    `, { accountId: session.accountId, userAmoId: session.userAmoId });

    if (!row) {
      await ctx.reply("Нет данных за последние 30 дней.");
      return;
    }

    const assistCtx = await buildAssistantContext(session.accountId);
    const managerName = assistCtx.managersById.get(session.userAmoId) ?? "Вы";
    const plan: number = assistCtx.planTargets[String(session.userAmoId)] ?? 0;
    const planLine = plan > 0
      ? `\nПлан: ${md(formatCurrency(plan))} \\(${md(formatPct((row.revenue_won / plan) * 100))}\\)`
      : "";

    const text =
      `📈 *Мои показатели за 30 дней*\n` +
      `Менеджер: ${md(managerName)}\n\n` +
      `Выручка: *${md(formatCurrency(Math.round(row.revenue_won)))}*${planLine}\n` +
      `Сделок закрыто: *${md(row.deals_won)}* / создано: ${md(row.deals_created)}\n` +
      `Win Rate: *${md(formatPct(row.win_rate * 100))}*\n` +
      `Звонков: *${md(row.calls_made)}*\n` +
      `Скорость ответа \\(p50\\): ${md(Math.round(row.response_time_p50))} мин\n` +
      `Ср\\. скорость сделки: ${md(Math.round(row.deal_velocity_avg))} дней`;

    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  },

  async myDeals(ctx: Context, session: BotSession): Promise<void> {
    if (!session.userAmoId) {
      await ctx.reply("Ваш аккаунт AmoCRM не привязан. Обратитесь к администратору.");
      return;
    }

    const assistCtx = await buildAssistantContext(session.accountId);

    const openDeals = await db.query.deals.findMany({
      where: and(
        eq(deals.accountId, session.accountId),
        eq(deals.responsibleUserAmoId, session.userAmoId),
        eq(deals.isDeleted, false),
        eq(deals.closedStatus, 0)
      ),
      orderBy: (d, { desc }) => desc(d.price),
      limit: 15,
    });

    const items = openDeals.map((d) => ({
      name: d.name,
      price: Number(d.price),
      stage: assistCtx.stagesById.get(d.stageAmoId) ?? `Stage #${d.stageAmoId}`,
    }));

    await ctx.reply(
      formatDealsList(items, `Мои сделки (${openDeals.length})`),
      { parse_mode: "MarkdownV2" }
    );
  },

  async myTasks(ctx: Context, session: BotSession): Promise<void> {
    if (!session.userAmoId) {
      await ctx.reply("Ваш аккаунт AmoCRM не привязан. Обратитесь к администратору.");
      return;
    }

    const assistCtx = await buildAssistantContext(session.accountId);
    const managerName = assistCtx.managersById.get(session.userAmoId) ?? "Вы";

    const openTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.accountId, session.accountId),
        eq(tasks.responsibleUserAmoId, session.userAmoId),
        eq(tasks.isCompleted, false)
      ),
      orderBy: (t, { asc }) => asc(t.completeTill),
      limit: 20,
    });

    const items = openTasks.map((t) => ({
      text: t.text ?? "",
      due: t.completeTill,
      completed: t.isCompleted,
    }));

    await ctx.reply(formatTasksList(items, managerName), { parse_mode: "MarkdownV2" });
  },
};
