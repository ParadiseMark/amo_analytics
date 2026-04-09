import type { FastifyInstance } from "fastify";
import qs from "qs";
import { redisCache } from "../../lib/redis/index.js";
import { enqueueWebhookProcess } from "../../lib/queue/queues.js";
import { db } from "../../lib/db/index.js";
import { accounts } from "../../lib/db/schema.js";
import { eq } from "drizzle-orm";

// AmoCRM webhook deduplication TTL (24h)
const DEDUP_TTL_SECONDS = 86400;

export async function webhookRoutes(app: FastifyInstance) {
  // POST /api/v1/webhooks/:accountId
  // AmoCRM sends application/x-www-form-urlencoded
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, qs.parse(body as string, { allowDots: true, depth: 5 }));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.post<{ Params: { accountId: string } }>(
    "/:accountId",
    async (req, reply) => {
      // Must respond within 2 seconds — reply immediately
      reply.status(200).send("ok");

      const { accountId } = req.params;
      const payload = req.body as Record<string, unknown>;

      // Verify account exists
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: { id: true, subdomain: true },
      });

      if (!account) {
        req.log.warn({ accountId }, "Webhook for unknown account");
        return;
      }

      // Parse AmoCRM nested webhook format: leads[status][0][id] etc.
      await processWebhookPayload(account.id, account.subdomain, payload, req.log);
    }
  );
}

type WebhookEntities = {
  leads?: Record<string, Record<string, unknown>[]>;
  contacts?: Record<string, Record<string, unknown>[]>;
  companies?: Record<string, Record<string, unknown>[]>;
  tasks?: Record<string, Record<string, unknown>[]>;
};

async function processWebhookPayload(
  accountId: string,
  subdomain: string,
  payload: Record<string, unknown>,
  log: { warn: (obj: unknown, msg: string) => void; info: (obj: unknown, msg: string) => void }
) {
  const entities = payload as WebhookEntities;

  const jobs: Array<{ entityType: string; entityId: number; eventType: string; raw: Record<string, unknown> }> = [];

  // leads[status], leads[add], leads[update], leads[delete]
  for (const [eventType, items] of Object.entries(entities.leads ?? {})) {
    for (const item of Object.values(items)) {
      const entityId = parseInt(String(item.id));
      if (!isNaN(entityId)) {
        jobs.push({ entityType: "leads", entityId, eventType, raw: item });
      }
    }
  }

  for (const [eventType, items] of Object.entries(entities.contacts ?? {})) {
    for (const item of Object.values(items)) {
      const entityId = parseInt(String(item.id));
      if (!isNaN(entityId)) {
        jobs.push({ entityType: "contacts", entityId, eventType, raw: item });
      }
    }
  }

  for (const [eventType, items] of Object.entries(entities.tasks ?? {})) {
    for (const item of Object.values(items)) {
      const entityId = parseInt(String(item.id));
      if (!isNaN(entityId)) {
        jobs.push({ entityType: "tasks", entityId, eventType, raw: item });
      }
    }
  }

  for (const job of jobs) {
    // Deduplication: skip if we've seen this exact event recently
    const dedupKey = `wh:dedup:${accountId}:${job.entityType}:${job.entityId}:${job.eventType}`;
    const alreadySeen = await redisCache.set(dedupKey, "1", "EX", DEDUP_TTL_SECONDS, "NX");

    if (alreadySeen === null) {
      // NX failed = key already existed = duplicate
      continue;
    }

    await enqueueWebhookProcess({
      accountId,
      subdomain,
      entityType: job.entityType as any,
      entityAmoId: job.entityId,
      eventType: job.eventType,
      rawPayload: job.raw,
    });
  }

  log.info({ accountId, jobCount: jobs.length }, "Webhook processed");
}
