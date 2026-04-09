/**
 * Telegram bot — main entry point.
 * Two roles:
 *   supervisor — team reports, AI Q&A, funnel, bottleneck alerts
 *   manager    — own deals, own stats, own tasks, contact lookups, AI Q&A
 *
 * Auth: /start → magic link via email → session stored in Redis.
 */
import { Bot, session, type Context, type SessionFlavor } from "grammy";
import { env } from "../config/env.js";
import {
  generateMagicLink,
  getSession,
  clearSession,
  type MagicLinkPayload,
} from "./auth.js";
import { supervisorHandlers } from "./handlers/supervisor.js";
import { managerHandlers } from "./handlers/manager.js";
import { runAssistantSync } from "../ai/assistant.service.js";
import type { BotSession } from "./types.js";

// ─── Context type ─────────────────────────────────────────────────────────────

type BotContext = Context & SessionFlavor<{ waitingForEmail: boolean }>;

// ─── Bot instance ──────────────────────────────────────────────────────────────

if (!env.TELEGRAM_BOT_TOKEN) {
  console.warn("[bot] TELEGRAM_BOT_TOKEN not set — bot will not start");
}

export const bot = env.TELEGRAM_BOT_TOKEN
  ? new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN)
  : null;

// Simple in-memory session for auth state (not the analytics session)
if (bot) {
  bot.use(session({ initial: () => ({ waitingForEmail: false }) }));
}

// ─── Auth middleware ───────────────────────────────────────────────────────────

async function requireAuth(ctx: BotContext): Promise<BotSession | null> {
  const tgId = ctx.from?.id;
  if (!tgId) return null;
  return getSession(tgId);
}

// ─── Commands (only registered when bot is initialized) ───────────────────────

if (bot) {

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;

  const session = await getSession(tgId);
  if (session) {
    await ctx.reply(
      "Вы уже авторизованы.\n" +
      "Команды:\n" +
      "/report — отчёт команды\n" +
      "/my_stats — мои показатели\n" +
      "/my_deals — мои сделки\n" +
      "/tasks — мои задачи\n" +
      "/funnel — воронка\n" +
      "/logout — выход\n\n" +
      "Или просто напишите вопрос на русском языке."
    );
    return;
  }

  ctx.session.waitingForEmail = true;
  await ctx.reply(
    "Добро пожаловать в AMO Analytics Bot! 👋\n\n" +
    "Для входа введите email, на который вы зарегистрированы в системе:"
  );
});

// ─── /logout ──────────────────────────────────────────────────────────────────

bot.command("logout", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  await clearSession(tgId);
  ctx.session.waitingForEmail = false;
  await ctx.reply("Вы вышли из системы. Введите /start для повторного входа.");
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Доступные команды:\n\n" +
    "/start — начало работы / вход\n" +
    "/report — отчёт по команде (руководителям)\n" +
    "/my_stats — мои KPI за 30 дней\n" +
    "/my_deals — мои активные сделки\n" +
    "/tasks — мои открытые задачи\n" +
    "/funnel — конверсия воронки\n" +
    "/logout — выход\n\n" +
    "Или задайте любой вопрос текстом — AI ответит на основе ваших данных."
  );
});

// ─── Supervisor commands ──────────────────────────────────────────────────────

bot.command("report", async (ctx) => {
  const session = await requireAuth(ctx);
  if (!session) return ctx.reply("Войдите через /start");
  if (session.role !== "supervisor") return ctx.reply("Эта команда доступна только руководителям.");
  await supervisorHandlers.report(ctx, session);
});

bot.command("funnel", async (ctx) => {
  const session = await requireAuth(ctx);
  if (!session) return ctx.reply("Войдите через /start");
  await supervisorHandlers.funnel(ctx, session);
});

// ─── Manager commands ─────────────────────────────────────────────────────────

bot.command("my_stats", async (ctx) => {
  const session = await requireAuth(ctx);
  if (!session) return ctx.reply("Войдите через /start");
  await managerHandlers.myStats(ctx, session);
});

bot.command("my_deals", async (ctx) => {
  const session = await requireAuth(ctx);
  if (!session) return ctx.reply("Войдите через /start");
  await managerHandlers.myDeals(ctx, session);
});

bot.command("tasks", async (ctx) => {
  const session = await requireAuth(ctx);
  if (!session) return ctx.reply("Войдите через /start");
  await managerHandlers.myTasks(ctx, session);
});

// ─── Free text → AI assistant ─────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;

  // Handle email input during auth flow
  if (ctx.session.waitingForEmail) {
    const email = ctx.message.text.trim();
    const appBaseUrl = env.AMOCRM_REDIRECT_URI.replace("/api/v1/oauth/callback", "");
    const link = await generateMagicLink(tgId, email, appBaseUrl);

    if (!link) {
      await ctx.reply("Email не найден в системе. Проверьте адрес или обратитесь к администратору.");
      return;
    }

    ctx.session.waitingForEmail = false;
    await ctx.reply(
      `Ссылка для входа отправлена.\n\nНажмите для подтверждения: ${link}\n\n` +
      "Ссылка действительна 15 минут."
    );
    return;
  }

  // Route to AI assistant
  const session = await getSession(tgId);
  if (!session) {
    return ctx.reply("Войдите через /start");
  }

  const typingMsg = await ctx.reply("⏳ Обрабатываю запрос...");

  try {
    const answer = await runAssistantSync(session.accountId, [
      { role: "user", content: ctx.message.text },
    ]);

    await ctx.api.deleteMessage(ctx.chat.id, typingMsg.message_id);
    // Split long messages (Telegram limit 4096 chars)
    const chunks = splitMessage(answer, 4000);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: "MarkdownV2" });
    }
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat.id, typingMsg.message_id);
    await ctx.reply("Произошла ошибка при обработке запроса. Попробуйте ещё раз.");
    console.error("[bot] AI error:", err);
  }
});

} // end if (bot)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      // Try to break at a newline
      const nl = text.lastIndexOf("\n", end);
      if (nl > start) end = nl + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

// ─── Start bot ────────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  if (!bot) {
    console.warn("[bot] Bot not initialized — TELEGRAM_BOT_TOKEN not set");
    return;
  }
  console.log("[bot] Starting Telegram bot...");
  bot.start({
    onStart: () => console.log("[bot] Bot is running"),
  });
}
