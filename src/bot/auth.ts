/**
 * Bot authentication via magic link.
 *
 * Flow:
 *  1. User sends /start → bot asks for email
 *  2. User types email → generateMagicLink() stores a one-time token in Redis
 *  3. User clicks link → /api/v1/bot/auth?token=XXX&tgId=YYY
 *  4. Server resolves email → platform_user, links Telegram ID, sends confirmation
 *
 * The session (accountId, role, userAmoId) is stored in Redis keyed by Telegram ID
 * after the magic link is consumed.
 */
import { redisCache } from "../lib/redis/index.js";
import { db } from "../lib/db/index.js";
import { platformUsers, platformUserAccounts, users } from "../lib/db/schema.js";
import { eq, and } from "drizzle-orm";
import { randomBytes } from "crypto";
import type { BotSession } from "./types.js";

const MAGIC_LINK_TTL = 60 * 15;   // 15 minutes
const SESSION_TTL    = 60 * 60 * 24 * 30; // 30 days

// ─── Magic link generation ────────────────────────────────────────────────────

export async function generateMagicLink(
  telegramId: number,
  email: string,
  baseUrl: string
): Promise<string | null> {
  // Verify the email belongs to a known platform user
  const user = await db.query.platformUsers.findFirst({
    where: eq(platformUsers.email, email.toLowerCase().trim()),
  });
  if (!user) return null;

  const token = randomBytes(32).toString("hex");
  await redisCache.setex(
    `bot:magic:${token}`,
    MAGIC_LINK_TTL,
    JSON.stringify({ telegramId, platformUserId: user.id, email: user.email })
  );

  return `${baseUrl}/api/v1/bot/auth?token=${token}&tgId=${telegramId}`;
}

// ─── Magic link consumption (called from HTTP route) ─────────────────────────

export type MagicLinkPayload = {
  telegramId: number;
  platformUserId: string;
  email: string;
};

export async function consumeMagicLink(token: string): Promise<MagicLinkPayload | null> {
  const raw = await redisCache.get(`bot:magic:${token}`);
  if (!raw) return null;
  await redisCache.del(`bot:magic:${token}`);
  return JSON.parse(raw) as MagicLinkPayload;
}

// ─── Session management ───────────────────────────────────────────────────────

function sessionKey(telegramId: number): string {
  return `bot:session:${telegramId}`;
}

export async function createSession(
  telegramId: number,
  platformUserId: string
): Promise<BotSession | null> {
  // Resolve the first account the user has access to
  const access = await db.query.platformUserAccounts.findFirst({
    where: eq(platformUserAccounts.platformUserId, platformUserId),
  });
  if (!access) return null;

  const accountId = access.accountId;
  const role = (access.role as BotSession["role"]) ?? "manager";

  // Try to find an AmoCRM user with matching platform user email
  const platformUser = await db.query.platformUsers.findFirst({
    where: eq(platformUsers.id, platformUserId),
    columns: { email: true },
  });

  let userAmoId: number | null = null;
  if (platformUser?.email) {
    const amoUser = await db.query.users.findFirst({
      where: and(
        eq(users.accountId, accountId),
        eq(users.email, platformUser.email)
      ),
      columns: { amoId: true },
    });
    userAmoId = amoUser?.amoId ?? null;
  }

  const session: BotSession = {
    accountId,
    platformUserId,
    role,
    userAmoId,
    lastSeen: new Date().toISOString(),
  };

  await redisCache.setex(sessionKey(telegramId), SESSION_TTL, JSON.stringify(session));
  return session;
}

export async function getSession(telegramId: number): Promise<BotSession | null> {
  const raw = await redisCache.get(sessionKey(telegramId));
  if (!raw) return null;

  const session = JSON.parse(raw) as BotSession;
  // Refresh TTL on each access
  session.lastSeen = new Date().toISOString();
  await redisCache.setex(sessionKey(telegramId), SESSION_TTL, JSON.stringify(session));
  return session;
}

export async function clearSession(telegramId: number): Promise<void> {
  await redisCache.del(sessionKey(telegramId));
}
