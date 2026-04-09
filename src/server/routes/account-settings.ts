/**
 * Account settings API.
 *
 * GET  /api/v1/accounts/:accountId/settings  — read settings + status
 * PATCH /api/v1/accounts/:accountId/settings  — update settings (admin only)
 * GET  /api/v1/accounts/:accountId/users      — list users with KPI context
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { db } from "../../lib/db/index.js";
import { accounts, platformUserAccounts, users, pipelines, pipelineStages } from "../../lib/db/schema.js";
import { and, eq } from "drizzle-orm";
import { setAccountContext } from "../../lib/db/rls.js";
import type { AccountSettings } from "../../lib/db/schema.js";

// ─── Auth + RLS middleware ────────────────────────────────────────────────────

async function requireAccountAccess(
  req: FastifyRequest<{ Params: { accountId: string } }>,
  reply: FastifyReply,
  requireAdmin = false
): Promise<string | null> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }

  const userId = (req.user as { sub: string }).sub;
  const { accountId } = req.params;

  const access = await db.query.platformUserAccounts.findFirst({
    where: and(
      eq(platformUserAccounts.platformUserId, userId),
      eq(platformUserAccounts.accountId, accountId)
    ),
  });

  if (!access) {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }

  if (requireAdmin && access.role !== "admin") {
    reply.code(403).send({ error: "Admin role required" });
    return null;
  }

  await setAccountContext(accountId, userId);
  return userId;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function accountSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /accounts/:accountId/settings ─────────────────────────────────────
  app.get("/:accountId/settings", async (req, reply) => {
    const userId = await requireAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply
    );
    if (!userId) return;

    const { accountId } = req.params as { accountId: string };

    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
      columns: {
        id: true,
        subdomain: true,
        name: true,
        amoAccountId: true,
        settings: true,
        syncStatus: true,
        needsReauth: true,
        tokenExpiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!account) return reply.code(404).send({ error: "Account not found" });

    const tokenDaysLeft = Math.round(
      (account.tokenExpiresAt.getTime() - Date.now()) / (24 * 3600 * 1000)
    );

    return reply.send({
      ...account,
      tokenDaysLeft,
    });
  });

  // ── PATCH /accounts/:accountId/settings ───────────────────────────────────
  app.patch("/:accountId/settings", async (req, reply) => {
    const userId = await requireAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply,
      true // admin only
    );
    if (!userId) return;

    const { accountId } = req.params as { accountId: string };

    const body = z
      .object({
        timezone: z.string().optional(),
        currency: z.string().max(10).optional(),
        // Plan targets: map of userAmoId (string) → monthly revenue target (number)
        planTargets: z.record(z.string(), z.number().min(0)).optional(),
        stuckDaysThreshold: z.number().int().min(1).max(365).optional(),
        bottleneckMultiplier: z.number().min(1).max(10).optional(),
      })
      .parse(req.body);

    // Merge with existing settings (don't overwrite unrelated keys)
    const existing = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
      columns: { settings: true },
    });

    const merged: AccountSettings = {
      ...(existing?.settings ?? {}),
      ...Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined)
      ),
    };

    const [updated] = await db
      .update(accounts)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(accounts.id, accountId))
      .returning({
        id: accounts.id,
        settings: accounts.settings,
        updatedAt: accounts.updatedAt,
      });

    return reply.send(updated);
  });

  // ── GET /accounts/:accountId/users ────────────────────────────────────────
  // Returns AmoCRM users (managers) for this account
  app.get("/:accountId/users", async (req, reply) => {
    const userId = await requireAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply
    );
    if (!userId) return;

    const { accountId } = req.params as { accountId: string };

    const managerList = await db
      .select({
        amoId: users.amoId,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(eq(users.accountId, accountId), eq(users.isActive, true)))
      .orderBy(users.name);

    // Fetch plan targets from account settings to annotate response
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
      columns: { settings: true },
    });
    const planTargets = (account?.settings as AccountSettings)?.planTargets ?? {};

    return reply.send({
      users: managerList.map((u) => ({
        ...u,
        planTarget: planTargets[String(u.amoId)] ?? null,
      })),
    });
  });

  // ── GET /accounts/:accountId/pipelines ───────────────────────────────────
  // Returns pipelines with their stages for this account
  app.get("/:accountId/pipelines", async (req, reply) => {
    const userId = await requireAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply
    );
    if (!userId) return;

    const { accountId } = req.params as { accountId: string };

    const pipelineList = await db
      .select({
        id: pipelines.id,
        amoId: pipelines.amoId,
        name: pipelines.name,
        isMain: pipelines.isMain,
        sort: pipelines.sort,
      })
      .from(pipelines)
      .where(and(eq(pipelines.accountId, accountId), eq(pipelines.isDeleted, false)))
      .orderBy(pipelines.sort);

    const stageList = await db
      .select({
        amoId: pipelineStages.amoId,
        pipelineId: pipelineStages.pipelineId,
        name: pipelineStages.name,
        sort: pipelineStages.sort,
        type: pipelineStages.type,
      })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.accountId, accountId), eq(pipelineStages.isDeleted, false)))
      .orderBy(pipelineStages.sort);

    // Group stages by pipeline internal id
    const stagesByPipeline = new Map<number, typeof stageList>();
    for (const s of stageList) {
      const arr = stagesByPipeline.get(s.pipelineId) ?? [];
      arr.push(s);
      stagesByPipeline.set(s.pipelineId, arr);
    }

    return reply.send({
      pipelines: pipelineList.map((p) => ({
        amoId: p.amoId,
        name: p.name,
        isMain: p.isMain,
        stages: (stagesByPipeline.get(p.id) ?? []).map((s) => ({
          amoId: s.amoId,
          name: s.name,
          type: s.type,
        })),
      })),
    });
  });

  // ── PATCH /accounts/:accountId/sync/trigger ───────────────────────────────
  // Manual sync trigger (admin only)
  app.post("/:accountId/sync/trigger", async (req, reply) => {
    const userId = await requireAccountAccess(
      req as FastifyRequest<{ Params: { accountId: string } }>,
      reply,
      true
    );
    if (!userId) return;

    const { accountId } = req.params as { accountId: string };

    const { enqueueFullSync } = await import("../../lib/queue/queues.js");
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
      columns: { subdomain: true },
    });
    if (!account) return reply.code(404).send({ error: "Account not found" });

    await enqueueFullSync(accountId, account.subdomain);
    return reply.send({ ok: true, message: "Full sync queued" });
  });
}
