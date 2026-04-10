import type { FastifyInstance } from "fastify";
import axios from "axios";
import { eq } from "drizzle-orm";
import { db } from "../../lib/db/index.js";
import { accounts, platformUserAccounts } from "../../lib/db/schema.js";
import { saveTokens } from "../../services/amo-client/TokenManager.js";
import { enqueueFullSync } from "../../lib/queue/queues.js";
import { registerAccountJobs } from "../../workers/scheduler/scheduler.js";
import { startWorkersForAccount } from "../../workers/bootstrap.js";
import { redis } from "../../lib/redis/index.js";
import { env } from "../../config/env.js";
import type { TokenResponse, AmoAccount } from "../../services/amo-client/types.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3001";
const STATE_TTL = 600; // 10 минут

export async function oauthRoutes(app: FastifyInstance) {
  // ─── Step 1: Start OAuth flow ─────────────────────────────────────────────
  // GET /api/v1/oauth/start  (требует JWT — чтобы знать кто подключает)
  app.get<{ Querystring: { token?: string } }>("/start", async (req, reply) => {
    // Проверяем JWT чтобы привязать аккаунт к пользователю в callback
    let userId: string | null = null;
    try {
      await req.jwtVerify();
      userId = (req.user as { sub: string }).sub;
    } catch {
      // Fallback: токен может прийти как query-параметр (browser redirect не поддерживает заголовки)
      const queryToken = req.query.token;
      if (queryToken) {
        try {
          const decoded = app.jwt.verify(queryToken) as { sub: string };
          userId = decoded.sub;
        } catch { /* невалидный токен — продолжаем без привязки */ }
      }
    }

    const state = generateState();

    // Сохраняем userId по state в Redis
    if (userId) {
      await redis.setex(`oauth:state:${state}`, STATE_TTL, userId);
    }

    const url = new URL("https://www.amocrm.ru/oauth");
    url.searchParams.set("client_id", env.AMOCRM_CLIENT_ID);
    url.searchParams.set("redirect_uri", env.AMOCRM_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("mode", "popup");
    return reply.redirect(url.toString());
  });

  // ─── Step 2: OAuth callback ───────────────────────────────────────────────
  // GET /api/v1/oauth/callback?code=XXX&referer=SUBDOMAIN&state=XXX
  app.get<{
    Querystring: { code?: string; referer?: string; state?: string; error?: string };
  }>("/callback", async (req, reply) => {
    const { code, referer, state, error } = req.query;

    if (error || !code || !referer) {
      return reply.redirect(
        `${FRONTEND_URL}/dashboard/connect?error=${encodeURIComponent(error ?? "Нет кода авторизации")}`
      );
    }

    // Восстанавливаем userId из state (если был)
    let userId: string | null = null;
    if (state) {
      userId = await redis.get(`oauth:state:${state}`);
      if (userId) await redis.del(`oauth:state:${state}`);
    }

    const subdomain = referer.replace(/\.amocrm\.ru$/, "");

    // Обмен кода на токены
    let tokenData: TokenResponse;
    try {
      const response = await axios.post<TokenResponse>(
        `https://${subdomain}.amocrm.ru/oauth2/access_token`,
        {
          client_id: env.AMOCRM_CLIENT_ID,
          client_secret: env.AMOCRM_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: env.AMOCRM_REDIRECT_URI,
        }
      );
      tokenData = response.data;
    } catch (err) {
      req.log.error({ err }, "Failed to exchange OAuth code");
      return reply.redirect(
        `${FRONTEND_URL}/dashboard/connect?error=${encodeURIComponent("Не удалось обменять код на токены")}`
      );
    }

    // Получаем информацию об аккаунте AmoCRM
    let amoAccount: AmoAccount;
    try {
      const response = await axios.get<AmoAccount>(
        `https://${subdomain}.amocrm.ru/api/v4/account`,
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
      );
      amoAccount = response.data;
    } catch (err) {
      req.log.error({ err }, "Failed to fetch AmoCRM account info");
      return reply.redirect(
        `${FRONTEND_URL}/dashboard/connect?error=${encodeURIComponent("Не удалось получить данные аккаунта")}`
      );
    }

    // Upsert аккаунт (placeholder токены, реальные пишутся ниже через HKDF)
    const [account] = await db
      .insert(accounts)
      .values({
        subdomain,
        amoAccountId: amoAccount.id,
        name: amoAccount.name,
        accessToken: "pending",
        refreshToken: "pending",
        tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
        syncStatus: "pending",
        settings: { timezone: amoAccount.timezone },
      })
      .onConflictDoUpdate({
        target: accounts.subdomain,
        set: {
          amoAccountId: amoAccount.id,
          name: amoAccount.name,
          tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
          needsReauth: false,
          syncStatus: "pending",
          updatedAt: new Date(),
        },
      })
      .returning({ id: accounts.id, subdomain: accounts.subdomain });

    // Шифруем токены с per-account HKDF-ключом
    await saveTokens(account.id, tokenData.access_token, tokenData.refresh_token, tokenData.expires_in);

    // Привязываем платформенного пользователя к аккаунту (если знаем кто он)
    if (userId) {
      await db
        .insert(platformUserAccounts)
        .values({ platformUserId: userId, accountId: account.id, role: "admin" })
        .onConflictDoNothing();
    }

    // Запускаем начальную синхронизацию, регистрируем повторяющиеся задачи и workers
    await enqueueFullSync(account.id, subdomain);
    await registerAccountJobs(account.id);
    startWorkersForAccount(account.id);

    req.log.info({ accountId: account.id, subdomain }, "Аккаунт подключён, синхронизация запущена");

    // Редирект во фронтенд с признаком успеха
    return reply.redirect(`${FRONTEND_URL}/dashboard/connect?success=1&subdomain=${subdomain}`);
  });

  // ─── Disconnect ───────────────────────────────────────────────────────────
  // DELETE /api/v1/oauth/:accountId
  app.delete<{ Params: { accountId: string } }>(
    "/:accountId",
    async (req, reply) => {
      const { accountId } = req.params;

      const account = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
      });

      if (!account) {
        return reply.status(404).send({ error: "Account not found" });
      }

      await db.update(accounts).set({ syncStatus: "disconnected" }).where(eq(accounts.id, accountId));

      req.log.info({ accountId }, "Account disconnected");
      return reply.send({ success: true });
    }
  );

  // ─── Sync status ──────────────────────────────────────────────────────────
  // GET /api/v1/oauth/:accountId/status
  app.get<{ Params: { accountId: string } }>(
    "/:accountId/status",
    async (req, reply) => {
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.id, req.params.accountId),
        columns: {
          id: true,
          subdomain: true,
          name: true,
          syncStatus: true,
          needsReauth: true,
          updatedAt: true,
        },
      });

      if (!account) return reply.status(404).send({ error: "Account not found" });
      return reply.send(account);
    }
  );
}

function generateState(): string {
  return Math.random().toString(36).substring(2, 15);
}
