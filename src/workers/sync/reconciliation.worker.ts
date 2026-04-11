/**
 * Nightly reconciliation worker.
 * Re-syncs all entities updated in the last 48 hours to catch any webhook misses.
 * Runs as part of the sync:{accountId} queue.
 */
import { Worker } from "bullmq";
import { redis } from "../../lib/redis/index.js";
import { getAmoClient } from "../../services/amo-client/AmoClient.js";
import { db } from "../../lib/db/index.js";
import { deals, contacts, tasks, accounts } from "../../lib/db/schema.js";
import { sql } from "drizzle-orm";
import { unixToDate } from "./sync.utils.js";

type ReconciliationJobData = { accountId: string };

export async function runReconciliation(accountId: string): Promise<void> {
  const account = await db.query.accounts.findFirst({ where: (a, { eq }) => eq(a.id, accountId) });
  if (!account) throw new Error(`Account ${accountId} not found`);
  const client = getAmoClient(accountId, account.subdomain);

  const since = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000);

  console.log(`[reconciliation] Starting 48h reconciliation for account=${accountId}`);

  let dealsCount = 0;
  for await (const page of client.paginate<any>("/leads", "leads", {
    "filter[updated_at][from]": since,
    with: "contacts",
  })) {
    for (const d of page) {
      await db.insert(deals).values({
        accountId, amoId: d.id, name: d.name, price: d.price ?? 0,
        statusId: d.status_id, pipelineAmoId: d.pipeline_id, stageAmoId: d.status_id,
        responsibleUserAmoId: d.responsible_user_id,
        closedStatus: d.closed_at ? (d.status_id === 142 ? 1 : 2) : 0,
        closedAt: d.closed_at ? unixToDate(d.closed_at) : null,
        createdAt: unixToDate(d.created_at), updatedAt: unixToDate(d.updated_at),
        customFields: (d.custom_fields_values ?? []) as any,
        tags: (d.tags ?? []).map((t: { name: string }) => t.name), isDeleted: false,
      }).onConflictDoUpdate({
        target: [deals.accountId, deals.amoId],
        set: {
          name: sql`excluded.name`, price: sql`excluded.price`,
          statusId: sql`excluded.status_id`, pipelineAmoId: sql`excluded.pipeline_amo_id`,
          stageAmoId: sql`excluded.stage_amo_id`, responsibleUserAmoId: sql`excluded.responsible_user_amo_id`,
          closedStatus: sql`excluded.closed_status`, closedAt: sql`excluded.closed_at`,
          updatedAt: sql`excluded.updated_at`, customFields: sql`excluded.custom_fields`,
          tags: sql`excluded.tags`,
        },
      });
    }
    dealsCount += page.length;
  }

  let contactsCount = 0;
  for await (const page of client.paginate<any>("/contacts", "contacts", { "filter[updated_at][from]": since })) {
    for (const c of page) {
      await db.insert(contacts).values({
        accountId, amoId: c.id, name: c.name,
        responsibleUserAmoId: c.responsible_user_id,
        createdAt: unixToDate(c.created_at), updatedAt: unixToDate(c.updated_at),
        customFields: (c.custom_fields_values ?? []) as any,
      }).onConflictDoUpdate({
        target: [contacts.accountId, contacts.amoId],
        set: {
          name: sql`excluded.name`, responsibleUserAmoId: sql`excluded.responsible_user_amo_id`,
          updatedAt: sql`excluded.updated_at`, customFields: sql`excluded.custom_fields`,
        },
      });
    }
    contactsCount += page.length;
  }

  let tasksCount = 0;
  for await (const page of client.paginate<any>("/tasks", "tasks", { "filter[updated_at][from]": since })) {
    for (const t of page) {
      await db.insert(tasks).values({
        accountId, amoId: t.id,
        entityType: (t.entity_type ?? "leads") as "leads" | "contacts" | "companies" | "tasks",
        entityAmoId: t.entity_id, text: t.text, taskTypeId: t.task_type_id,
        responsibleUserAmoId: t.responsible_user_id,
        isCompleted: t.is_completed ?? false,
        completedAt: t.is_completed && t.updated_at ? unixToDate(t.updated_at) : null,
        completeTill: t.complete_till ? unixToDate(t.complete_till) : null,
        createdAt: unixToDate(t.created_at), updatedAt: unixToDate(t.updated_at),
      }).onConflictDoUpdate({
        target: [tasks.accountId, tasks.amoId],
        set: {
          isCompleted: sql`excluded.is_completed`, completedAt: sql`excluded.completed_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    }
    tasksCount += page.length;
  }

  console.log(`[reconciliation] account=${accountId} deals=${dealsCount} contacts=${contactsCount} tasks=${tasksCount}`);
}

export function startReconciliationWorker(): Worker {
  return new Worker<ReconciliationJobData>(
    "reconciliation",
    async (job) => runReconciliation(job.data.accountId),
    { connection: redis, concurrency: 1 }
  );
}
