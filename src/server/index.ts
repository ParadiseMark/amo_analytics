import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import { env } from "../config/env.js";
import { checkDbConnection } from "../lib/db/index.js";
import { checkRedisConnection } from "../lib/redis/index.js";
import { runClickHouseMigrations } from "../lib/clickhouse/migrations.js";
import { bootstrapScheduler } from "../workers/scheduler/scheduler.js";
import { bootstrapReportSchedules } from "../workers/reports/scheduled-reports.worker.js";
import { bootstrapAllWorkers } from "../workers/bootstrap.js";
import { applyRlsPolicies } from "../lib/db/rls.js";
import { applyPgvectorMigration } from "../lib/db/pgvector.js";
import { authRoutes } from "./routes/auth.js";
import { oauthRoutes } from "./routes/oauth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { aiRoutes } from "./routes/ai.js";
import { botAuthRoutes } from "./routes/bot-auth.js";
import { reportRoutes } from "./routes/reports.js";
import { accountSettingsRoutes } from "./routes/account-settings.js";
import { startBot } from "../bot/bot.js";
import { registerBullBoard } from "./bull-board.js";

const app = Fastify({
  logger:
    env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } }
      : true,
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

await app.register(cors, {
  origin: env.NODE_ENV === "development" ? true : process.env.FRONTEND_URL,
  credentials: true,
});

await app.register(jwt, {
  secret: env.JWT_SECRET,
  sign: { expiresIn: env.JWT_EXPIRES_IN },
});

await app.register(cookie);

// ─── Routes ───────────────────────────────────────────────────────────────────

await app.register(authRoutes,    { prefix: "/api/v1/auth" });
await app.register(oauthRoutes,   { prefix: "/api/v1/oauth" });
await app.register(webhookRoutes, { prefix: "/api/v1/webhooks" });
await app.register(analyticsRoutes, { prefix: "/api/v1/analytics" });
await app.register(aiRoutes, { prefix: "/api/v1/ai" });
await app.register(botAuthRoutes, { prefix: "/api/v1/bot" });
await app.register(reportRoutes,          { prefix: "/api/v1/reports" });
await app.register(accountSettingsRoutes, { prefix: "/api/v1/accounts" });
await registerBullBoard(app);

// Health check
app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
  env: env.NODE_ENV,
}));

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  try {
    await checkDbConnection();
    app.log.info("PostgreSQL connected");

    await applyPgvectorMigration();
    app.log.info("pgvector migration applied");

    await applyRlsPolicies();
    app.log.info("PostgreSQL RLS policies applied");

    await checkRedisConnection();
    app.log.info("Redis connected");

    await runClickHouseMigrations();
    app.log.info("ClickHouse migrations applied");

    await bootstrapScheduler();
    app.log.info("Scheduler bootstrapped");

    await bootstrapReportSchedules();
    app.log.info("Report schedules bootstrapped");

    await bootstrapAllWorkers();
    app.log.info("BullMQ workers запущены");

    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Server listening on ${env.HOST}:${env.PORT}`);

    // Start Telegram bot if token is configured (non-blocking)
    if (env.TELEGRAM_BOT_TOKEN) {
      startBot().catch((err) => app.log.error({ err }, "[bot] Fatal error"));
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  app.log.info(`[shutdown] Получен ${signal}, завершаем...`);
  try {
    await app.close();
    app.log.info("[shutdown] Fastify закрыт");
  } catch (err) {
    app.log.error({ err }, "[shutdown] Ошибка при закрытии");
  }
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT",  () => shutdown("SIGINT"));
