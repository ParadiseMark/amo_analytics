/**
 * Bot magic link consumption endpoint.
 * The Telegram bot sends users here to complete authentication.
 *
 * GET /api/v1/bot/auth?token=XXX&tgId=YYY
 */
import type { FastifyInstance } from "fastify";
import { consumeMagicLink, createSession } from "../../bot/auth.js";
import { bot } from "../../bot/bot.js";

export async function botAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth", async (req, reply) => {
    const { token, tgId } = req.query as { token?: string; tgId?: string };

    if (!token || !tgId) {
      return reply.code(400).send({ error: "Missing token or tgId" });
    }

    const telegramId = Number(tgId);
    if (isNaN(telegramId)) {
      return reply.code(400).send({ error: "Invalid tgId" });
    }

    const payload = await consumeMagicLink(token);
    if (!payload) {
      return reply
        .type("text/html")
        .send("<h2>Ссылка недействительна или уже использована. Запросите новую через /start.</h2>");
    }

    const session = await createSession(telegramId, payload.platformUserId);
    if (!session) {
      return reply
        .type("text/html")
        .send("<h2>Аккаунт не найден. Обратитесь к администратору.</h2>");
    }

    // Notify the user in Telegram
    try {
      await bot.api.sendMessage(
        telegramId,
        `✅ Вы успешно вошли!\n\n` +
        `Роль: ${session.role === "supervisor" ? "Руководитель" : "Менеджер"}\n\n` +
        "Введите /help чтобы узнать доступные команды, или просто задайте вопрос."
      );
    } catch {
      // Bot might not be able to message the user yet — not critical
    }

    return reply
      .type("text/html")
      .send("<h2>✅ Авторизация прошла успешно. Вернитесь в Telegram.</h2>");
  });
}
