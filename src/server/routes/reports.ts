/**
 * Report builder REST API.
 *
 * Prefix: /api/v1/reports/:accountId
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../../lib/db/index.js";
import { platformUserAccounts } from "../../lib/db/schema.js";
import { and, eq } from "drizzle-orm";
import { setAccountContext } from "../../lib/db/rls.js";
import {
  createReport,
  updateReport,
  deleteReport,
  listReports,
  getReport,
  runReport,
  previewReport,
} from "../../reports/reports.service.js";
import { DslTranslationError } from "../../reports/translator.js";
import { ReportDslSchema } from "../../reports/dsl.js";
import {
  registerReportSchedule,
  unregisterReportSchedule,
} from "../../workers/reports/scheduled-reports.worker.js";
import { ZodError } from "zod";

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

  await setAccountContext(accountId, userId);
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", verifyAccountAccess);

  // ── List reports ───────────────────────────────────────────────────────────
  app.get("/:accountId", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const reports = await listReports(accountId);
    return reply.send({ reports });
  });

  // ── Get single report definition ───────────────────────────────────────────
  app.get("/:accountId/:reportId", async (req, reply) => {
    const { accountId, reportId } = req.params as { accountId: string; reportId: string };
    const report = await getReport(accountId, reportId);
    if (!report) return reply.code(404).send({ error: "Report not found" });
    return reply.send({ report });
  });

  // ── Create report ──────────────────────────────────────────────────────────
  app.post("/:accountId", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const userId = (req.user as { sub: string }).sub;

    try {
      const report = await createReport(accountId, userId, req.body);
      // Register schedule if provided
      const dsl = ReportDslSchema.safeParse(req.body);
      if (dsl.success && dsl.data.schedule?.cron) {
        await registerReportSchedule(accountId, report.id, dsl.data.schedule.cron);
      }
      return reply.code(201).send({ report });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "Invalid DSL", issues: err.issues });
      }
      if (err instanceof DslTranslationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── Update report ──────────────────────────────────────────────────────────
  app.put("/:accountId/:reportId", async (req, reply) => {
    const { accountId, reportId } = req.params as { accountId: string; reportId: string };

    try {
      const report = await updateReport(accountId, reportId, req.body);
      if (!report) return reply.code(404).send({ error: "Report not found" });
      // Re-register schedule (remove old, add new if present)
      await unregisterReportSchedule(accountId, reportId);
      const dsl = ReportDslSchema.safeParse(req.body);
      if (dsl.success && dsl.data.schedule?.cron) {
        await registerReportSchedule(accountId, report.id, dsl.data.schedule.cron);
      }
      return reply.send({ report });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "Invalid DSL", issues: err.issues });
      }
      if (err instanceof DslTranslationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── Delete report ──────────────────────────────────────────────────────────
  app.delete("/:accountId/:reportId", async (req, reply) => {
    const { accountId, reportId } = req.params as { accountId: string; reportId: string };
    await unregisterReportSchedule(accountId, reportId);
    await deleteReport(accountId, reportId);
    return reply.code(204).send();
  });

  // ── Run report ─────────────────────────────────────────────────────────────
  app.post("/:accountId/:reportId/run", async (req, reply) => {
    const { accountId, reportId } = req.params as { accountId: string; reportId: string };
    const { forceRefresh = false } = (req.body as { forceRefresh?: boolean }) ?? {};

    try {
      const result = await runReport(accountId, reportId, forceRefresh);
      return reply.send(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── Preview (no save) ──────────────────────────────────────────────────────
  app.post("/:accountId/preview", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };

    try {
      const result = await previewReport(accountId, req.body);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "Invalid DSL", issues: err.issues });
      }
      if (err instanceof DslTranslationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── Data source metadata (for builder UI) ─────────────────────────────────
  app.get("/:accountId/meta/sources", async (_req, reply) => {
    const { DATA_SOURCES, AGG_FUNCTIONS } = await import("../../reports/dsl.js");
    return reply.send({ sources: DATA_SOURCES, aggFunctions: AGG_FUNCTIONS });
  });
}
