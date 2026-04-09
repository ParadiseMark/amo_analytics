import { Worker } from "bullmq";
import { sql, eq, and } from "drizzle-orm";
import { redis } from "../../lib/redis/index.js";
import { db } from "../../lib/db/index.js";
import { deals, contacts, tasks, dealEvents } from "../../lib/db/schema.js";
import { getAmoClient } from "../../services/amo-client/AmoClient.js";
import { enqueueMetricsCompute } from "../../lib/queue/queues.js";
import { unixToDate } from "./sync.utils.js";
import type { WebhookProcessJobData } from "../../lib/queue/queues.js";

type DealEventType =
  | "created" | "status_change" | "responsible_change"
  | "price_change" | "won" | "lost" | "deleted" | "restored" | "field_change";

export const webhookProcessWorker = new Worker<WebhookProcessJobData>(
  "webhook",
  async (job) => {
    const { accountId, subdomain, entityType, entityAmoId, eventType } = job.data;
    const client = getAmoClient(accountId, subdomain);

    console.log(`[webhook] ${eventType} ${entityType}#${entityAmoId} account=${subdomain}`);

    if (entityType === "leads") {
      if (eventType === "delete") {
        await db
          .update(deals)
          .set({ isDeleted: true, syncedAt: new Date() })
          .where(and(eq(deals.accountId, accountId), eq(deals.amoId, entityAmoId)));
        return;
      }

      const deal = await client.getDeal(entityAmoId);
      await db
        .insert(deals)
        .values({
          accountId,
          amoId: deal.id,
          name: deal.name ?? null,
          price: deal.price?.toString() ?? "0",
          statusId: deal.status_id,
          pipelineAmoId: deal.pipeline_id,
          stageAmoId: deal.status_id,
          responsibleUserAmoId: deal.responsible_user_id,
          customFields: deal.custom_fields_values ?? null,
          tags: deal._embedded?.tags?.map((t) => t.name) ?? null,
          isDeleted: deal.is_deleted ?? false,
          closedStatus: deal.status_id === 142 ? 1 : deal.status_id === 143 ? 2 : 0,
          createdAt: unixToDate(deal.created_at),
          updatedAt: unixToDate(deal.updated_at),
          closedAt: unixToDate(deal.closed_at ?? undefined),
        })
        .onConflictDoUpdate({
          target: [deals.accountId, deals.amoId],
          set: {
            name: sql`excluded.name`,
            price: sql`excluded.price`,
            statusId: sql`excluded.status_id`,
            pipelineAmoId: sql`excluded.pipeline_amo_id`,
            stageAmoId: sql`excluded.stage_amo_id`,
            responsibleUserAmoId: sql`excluded.responsible_user_amo_id`,
            customFields: sql`excluded.custom_fields`,
            tags: sql`excluded.tags`,
            isDeleted: sql`excluded.is_deleted`,
            closedStatus: sql`excluded.closed_status`,
            updatedAt: sql`excluded.updated_at`,
            closedAt: sql`excluded.closed_at`,
            syncedAt: new Date(),
          },
        });

      await db
        .insert(dealEvents)
        .values({
          accountId,
          dealAmoId: entityAmoId,
          eventType: mapWebhookEvent(eventType),
          occurredAt: new Date(),
        })
        .onConflictDoNothing();

      if (deal.responsible_user_id) {
        await enqueueMetricsCompute({ accountId, userAmoId: deal.responsible_user_id });
      }
      return;
    }

    if (entityType === "contacts") {
      if (eventType === "delete") {
        await db
          .update(contacts)
          .set({ isDeleted: true, syncedAt: new Date() })
          .where(and(eq(contacts.accountId, accountId), eq(contacts.amoId, entityAmoId)));
        return;
      }

      const contact = await client.getContact(entityAmoId);
      await db
        .insert(contacts)
        .values({
          accountId,
          amoId: contact.id,
          name: contact.name ?? null,
          responsibleUserAmoId: contact.responsible_user_id,
          customFields: contact.custom_fields_values ?? null,
          isDeleted: contact.is_deleted ?? false,
          createdAt: unixToDate(contact.created_at),
          updatedAt: unixToDate(contact.updated_at),
        })
        .onConflictDoUpdate({
          target: [contacts.accountId, contacts.amoId],
          set: {
            name: sql`excluded.name`,
            customFields: sql`excluded.custom_fields`,
            updatedAt: sql`excluded.updated_at`,
            syncedAt: new Date(),
          },
        });
    }
  },
  {
    connection: redis,
    concurrency: 10,
  }
);

webhookProcessWorker.on("failed", (job, err) => {
  console.error(`[webhook-worker] Job ${job?.id} failed:`, err.message);
});

function mapWebhookEvent(eventType: string): DealEventType {
  const map: Record<string, DealEventType> = {
    add: "created",
    update: "field_change",
    delete: "deleted",
    status: "status_change",
    responsible: "responsible_change",
  };
  return map[eventType] ?? "field_change";
}
