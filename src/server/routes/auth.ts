/**
 * Platform user authentication.
 *
 * POST /api/v1/auth/register  — create account (admin-only or first user)
 * POST /api/v1/auth/login     — email + password → access + refresh tokens
 * POST /api/v1/auth/refresh   — refresh token → new access token
 * POST /api/v1/auth/logout    — revoke refresh token
 * GET  /api/v1/auth/me        — current user + accounts
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { db } from "../../lib/db/index.js";
import { platformUsers, platformUserAccounts, accounts } from "../../lib/db/schema.js";
import { eq, and } from "drizzle-orm";
import { redisCache } from "../../lib/redis/index.js";

const scryptAsync = promisify(scrypt);

// ─── Password helpers ─────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashed] = stored.split(":");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  const storedHash = Buffer.from(hashed, "hex");
  return timingSafeEqual(hash, storedHash);
}

// ─── Token helpers ────────────────────────────────────────────────────────────

const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days

function refreshKey(token: string): string {
  return `auth:refresh:${token}`;
}

async function issueTokens(
  app: FastifyInstance,
  userId: string,
  email: string,
  role: string
) {
  const accessToken = app.jwt.sign(
    { sub: userId, email, role },
    { expiresIn: "15m" }
  );

  const refreshToken = randomBytes(40).toString("hex");
  await redisCache.setex(refreshKey(refreshToken), REFRESH_TTL, userId);

  return { accessToken, refreshToken };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /register ─────────────────────────────────────────────────────────
  app.post("/register", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1).max(255),
        // Admin invite token for restricted registration
        inviteToken: z.string().optional(),
      })
      .parse(req.body);

    // Check if any users exist; first user becomes admin automatically
    const existing = await db.query.platformUsers.findFirst();
    const isFirstUser = !existing;

    // For non-first users, require invite token (simple shared secret)
    if (!isFirstUser) {
      const expectedToken = process.env.INVITE_TOKEN;
      if (!expectedToken || body.inviteToken !== expectedToken) {
        return reply.code(403).send({ error: "Valid invite token required" });
      }
    }

    // Check email uniqueness
    const duplicate = await db.query.platformUsers.findFirst({
      where: eq(platformUsers.email, body.email.toLowerCase()),
    });
    if (duplicate) {
      return reply.code(409).send({ error: "Email already registered" });
    }

    const passwordHash = await hashPassword(body.password);

    const [user] = await db
      .insert(platformUsers)
      .values({
        email: body.email.toLowerCase(),
        passwordHash,
        name: body.name,
        role: isFirstUser ? "admin" : "viewer",
      })
      .returning({ id: platformUsers.id, email: platformUsers.email, role: platformUsers.role });

    const tokens = await issueTokens(app, user.id, user.email, user.role);

    return reply.code(201).send({
      user: { id: user.id, email: user.email, name: body.name, role: user.role },
      ...tokens,
    });
  });

  // ── POST /login ────────────────────────────────────────────────────────────
  app.post("/login", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string(),
      })
      .parse(req.body);

    const user = await db.query.platformUsers.findFirst({
      where: eq(platformUsers.email, body.email.toLowerCase()),
    });

    // Constant-time response regardless of whether user exists (prevents timing-based enumeration).
    // Dummy hash: 32-char hex salt + ":" + 128-char hex hash (matches scrypt keylen=64).
    const DUMMY_HASH = `${"a".repeat(32)}:${"b".repeat(128)}`;
    const passwordOk = user
      ? await verifyPassword(body.password, user.passwordHash)
      : (await verifyPassword(body.password, DUMMY_HASH), false);

    if (!user || !passwordOk) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const tokens = await issueTokens(app, user.id, user.email, user.role);

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      ...tokens,
    });
  });

  // ── POST /refresh ──────────────────────────────────────────────────────────
  app.post("/refresh", async (req, reply) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string() })
      .parse(req.body);

    const userId = await redisCache.get(refreshKey(refreshToken));
    if (!userId) {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }

    const user = await db.query.platformUsers.findFirst({
      where: eq(platformUsers.id, userId),
      columns: { id: true, email: true, role: true },
    });

    if (!user) {
      await redisCache.del(refreshKey(refreshToken));
      return reply.code(401).send({ error: "User not found" });
    }

    // Rotate refresh token
    await redisCache.del(refreshKey(refreshToken));
    const tokens = await issueTokens(app, user.id, user.email, user.role);

    return reply.send(tokens);
  });

  // ── POST /logout ───────────────────────────────────────────────────────────
  app.post("/logout", async (req, reply) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string() })
      .parse(req.body);

    await redisCache.del(refreshKey(refreshToken));
    return reply.code(204).send();
  });

  // ── GET /me ────────────────────────────────────────────────────────────────
  app.get("/me", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const userId = (req.user as { sub: string }).sub;

    const user = await db.query.platformUsers.findFirst({
      where: eq(platformUsers.id, userId),
      columns: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    if (!user) return reply.code(404).send({ error: "User not found" });

    // Fetch accessible accounts
    const accessRows = await db
      .select({
        accountId: platformUserAccounts.accountId,
        role: platformUserAccounts.role,
        accountName: accounts.name,
        subdomain: accounts.subdomain,
        syncStatus: accounts.syncStatus,
      })
      .from(platformUserAccounts)
      .innerJoin(accounts, eq(accounts.id, platformUserAccounts.accountId))
      .where(eq(platformUserAccounts.platformUserId, userId));

    return reply.send({ user, accounts: accessRows });
  });

  // ── POST /accounts/:accountId/users — invite user to account ──────────────
  app.post("/accounts/:accountId/users", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const requesterId = (req.user as { sub: string }).sub;
    const { accountId } = req.params as { accountId: string };

    // Check requester is admin on this account
    const requesterAccess = await db.query.platformUserAccounts.findFirst({
      where: and(
        eq(platformUserAccounts.platformUserId, requesterId),
        eq(platformUserAccounts.accountId, accountId)
      ),
    });

    if (!requesterAccess || requesterAccess.role !== "admin") {
      return reply.code(403).send({ error: "Admin access required" });
    }

    const { email, role } = z
      .object({
        email: z.string().email(),
        role: z.enum(["admin", "viewer"]).default("viewer"),
      })
      .parse(req.body);

    const targetUser = await db.query.platformUsers.findFirst({
      where: eq(platformUsers.email, email.toLowerCase()),
      columns: { id: true },
    });

    if (!targetUser) {
      return reply.code(404).send({ error: "User not registered on the platform" });
    }

    await db
      .insert(platformUserAccounts)
      .values({ platformUserId: targetUser.id, accountId, role })
      .onConflictDoUpdate({
        target: [platformUserAccounts.platformUserId, platformUserAccounts.accountId],
        set: { role },
      });

    return reply.code(201).send({ ok: true });
  });
}
