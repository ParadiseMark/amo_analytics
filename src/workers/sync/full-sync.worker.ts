import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { redis } from "../../lib/redis/index.js";
import { db } from "../../lib/db/index.js";
import {
  accounts,
  users,
  pipelines,
  pipelineStages,
  customFieldDefinitions,
  deals,
  contacts,
  companies,
  tasks,
  notes,
  calls,
  dealEvents,
} from "../../lib/db/schema.js";
import { getAmoClient } from "../../services/amo-client/AmoClient.js";
import { updateSyncCursor, unixToDate, getMaxUpdatedAt, toEntityType, type EntityType } from "./sync.utils.js";
import { syncCursors } from "../../lib/db/schema.js";
import { and } from "drizzle-orm";
import { enqueueMetricsCompute } from "../../lib/queue/queues.js";
import type { FullSyncJobData, IncrementalSyncJobData } from "../../lib/queue/queues.js";
import { triggerIncrementalSync } from "../scheduler/scheduler.js";
import { runReconciliation } from "./reconciliation.worker.js";
import type {
  AmoUser,
  AmoPipeline,
  AmoCustomField,
  AmoDeal,
  AmoContact,
  AmoCompany,
  AmoTask,
  AmoNote,
  AmoEvent,
} from "../../services/amo-client/types.js";

const WORKER_CONCURRENCY = 2;

const workers = new Map<string, Worker>();

/** Запускает sync worker для конкретного аккаунта (full + incremental). Идемпотентен. */
export function createSyncWorker(accountId: string): Worker<FullSyncJobData | IncrementalSyncJobData> {
  if (workers.has(accountId)) return workers.get(accountId)!;

  const worker = new Worker<FullSyncJobData | IncrementalSyncJobData>(
    `sync-${accountId}`,
    async (job) => {
      if (job.name === "incremental-sync-trigger") {
        return triggerIncrementalSync(job.data.accountId);
      }
      if (job.name === "incremental-sync") {
        return processIncrementalJob(job as import("bullmq").Job<IncrementalSyncJobData>);
      }
      if (job.name === "nightly-reconciliation") {
        return runReconciliation(job.data.accountId);
      }
      return processJob(job as import("bullmq").Job<FullSyncJobData>);
    },
    { connection: redis, concurrency: WORKER_CONCURRENCY, stalledInterval: 300_000, lockDuration: 3_600_000 }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[sync:${accountId}] Job ${job?.id} (${job?.name}) failed:`, err.message);
    if (job?.name === "full-sync") {
      await db.update(accounts).set({ syncStatus: "error" }).where(eq(accounts.id, accountId));
    }
  });

  worker.on("stalled", async (jobId) => {
    console.error(`[sync:${accountId}] Job ${jobId} stalled`);
    await db.update(accounts).set({ syncStatus: "error" }).where(eq(accounts.id, accountId));
  });

  workers.set(accountId, worker);
  return worker;
}

export function stopSyncWorker(accountId: string): Promise<void> | undefined {
  const w = workers.get(accountId);
  if (!w) return;
  workers.delete(accountId);
  return w.close();
}

async function processIncrementalJob(job: import("bullmq").Job<IncrementalSyncJobData>) {
  const { accountId, subdomain, entityType, fromTimestamp } = job.data;
  const client = getAmoClient(accountId, subdomain);
  const updatedManagerIds = new Set<number>();

  console.log(`[inc-sync:${entityType}] ${subdomain} from=${new Date(fromTimestamp * 1000).toISOString()}`);

  if (entityType === "leads") {
    let count = 0;
    let maxUpdatedAt = fromTimestamp;
    for await (const batch of client.getDeals({ "filter[updated_at][from]": fromTimestamp, order: "updated_at" })) {
      await db.insert(deals).values(batch.map((d) => ({
        accountId, amoId: d.id, name: d.name ?? null, price: d.price?.toString() ?? "0",
        statusId: d.status_id, pipelineAmoId: d.pipeline_id, stageAmoId: d.status_id,
        responsibleUserAmoId: d.responsible_user_id, customFields: d.custom_fields_values ?? null,
        tags: d._embedded?.tags?.map((t) => t.name) ?? null, isDeleted: d.is_deleted ?? false,
        closedStatus: d.status_id === 142 ? 1 : d.status_id === 143 ? 2 : 0,
        createdAt: unixToDate(d.created_at), updatedAt: unixToDate(d.updated_at),
        closedAt: unixToDate(d.closed_at ?? undefined),
      }))).onConflictDoUpdate({
        target: [deals.accountId, deals.amoId],
        set: {
          name: sql`excluded.name`, price: sql`excluded.price`, statusId: sql`excluded.status_id`,
          pipelineAmoId: sql`excluded.pipeline_amo_id`, stageAmoId: sql`excluded.stage_amo_id`,
          responsibleUserAmoId: sql`excluded.responsible_user_amo_id`,
          customFields: sql`excluded.custom_fields`, tags: sql`excluded.tags`,
          isDeleted: sql`excluded.is_deleted`, closedStatus: sql`excluded.closed_status`,
          updatedAt: sql`excluded.updated_at`, closedAt: sql`excluded.closed_at`, syncedAt: new Date(),
        },
      });
      batch.forEach((d) => { if (d.responsible_user_id) updatedManagerIds.add(d.responsible_user_id); });
      const batchMax = getMaxUpdatedAt(batch);
      if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
      count += batch.length;
    }
    await updateSyncCursor(accountId, "leads", maxUpdatedAt, count);
  }

  if (entityType === "contacts") {
    let count = 0;
    let maxUpdatedAt = fromTimestamp;
    for await (const batch of client.getContacts({ "filter[updated_at][from]": fromTimestamp })) {
      await db.insert(contacts).values(batch.map((c) => ({
        accountId, amoId: c.id, name: c.name ?? null, responsibleUserAmoId: c.responsible_user_id,
        customFields: c.custom_fields_values ?? null, isDeleted: c.is_deleted ?? false,
        createdAt: unixToDate(c.created_at), updatedAt: unixToDate(c.updated_at),
      }))).onConflictDoUpdate({
        target: [contacts.accountId, contacts.amoId],
        set: { name: sql`excluded.name`, customFields: sql`excluded.custom_fields`, updatedAt: sql`excluded.updated_at`, syncedAt: new Date() },
      });
      const batchMax = getMaxUpdatedAt(batch);
      if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
      count += batch.length;
    }
    await updateSyncCursor(accountId, "contacts", maxUpdatedAt, count);
  }

  if (entityType === "tasks") {
    let count = 0;
    let maxUpdatedAt = fromTimestamp;
    for await (const batch of client.getTasks({ "filter[updated_at][from]": fromTimestamp, "filter[is_completed]": 0 })) {
      await db.insert(tasks).values(batch.map((t) => ({
        accountId, amoId: t.id, entityType: toEntityType(t.entity_type), entityAmoId: t.entity_id,
        responsibleUserAmoId: t.responsible_user_id, taskTypeId: t.task_type_id, text: t.text ?? null,
        completeTill: unixToDate(t.complete_till), isCompleted: t.is_completed ?? false,
        createdAt: unixToDate(t.created_at), updatedAt: unixToDate(t.updated_at),
      }))).onConflictDoUpdate({
        target: [tasks.accountId, tasks.amoId],
        set: { isCompleted: sql`excluded.is_completed`, updatedAt: sql`excluded.updated_at`, syncedAt: new Date() },
      });
      batch.forEach((t) => { if (t.responsible_user_id) updatedManagerIds.add(t.responsible_user_id); });
      const batchMax = getMaxUpdatedAt(batch);
      if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
      count += batch.length;
    }
    await updateSyncCursor(accountId, "tasks", maxUpdatedAt, count);
  }

  for (const userAmoId of updatedManagerIds) {
    await enqueueMetricsCompute({ accountId, userAmoId });
  }
}

/** Returns the set of entity types already completed in the current job run. */
async function getSyncedEntities(accountId: string, jobStartedAt: Date): Promise<Set<EntityType>> {
  const cursors = await db
    .select({ entityType: syncCursors.entityType, lastSyncedAt: syncCursors.lastSyncedAt })
    .from(syncCursors)
    .where(and(eq(syncCursors.accountId, accountId)));

  const done = new Set<EntityType>();
  for (const c of cursors) {
    if (c.lastSyncedAt && c.lastSyncedAt >= jobStartedAt) {
      done.add(c.entityType as EntityType);
    }
  }
  return done;
}

async function processJob(job: import("bullmq").Job<FullSyncJobData>) {
    const { accountId, subdomain } = job.data;
    const client = getAmoClient(accountId, subdomain);

    // Job creation time — used to detect which entities were already synced in this run.
    // If a cursor's lastSyncedAt >= jobStartedAt, the entity completed and can be skipped on retry.
    const jobStartedAt = new Date(job.timestamp);

    const synced = await getSyncedEntities(accountId, jobStartedAt);

    if (synced.size > 0) {
      console.log(`[full-sync] Resuming ${subdomain} — already done: ${[...synced].join(", ")}`);
    } else {
      console.log(`[full-sync] Starting for account ${subdomain} (${accountId})`);
    }

    await db
      .update(accounts)
      .set({ syncStatus: "syncing", updatedAt: new Date() })
      .where(eq(accounts.id, accountId));

    try {
      await job.updateProgress(5);
      if (!synced.has("users")) await syncUsers(accountId, client);

      await job.updateProgress(15);
      if (!synced.has("pipelines")) await syncPipelines(accountId, client);

      await job.updateProgress(25);
      if (!synced.has("custom_fields")) await syncCustomFields(accountId, client);

      await job.updateProgress(35);
      // Deals must come first (pipeline/stage FKs needed), then parallel batch
      if (!synced.has("leads")) {
        await syncSafe(() => syncDeals(accountId, client), "deals");
      }

      await job.updateProgress(50);
      // Contacts, companies, tasks are independent — run in parallel (shared rate limiter)
      await Promise.all([
        synced.has("contacts") ? Promise.resolve() : syncSafe(() => syncContacts(accountId, client), "contacts"),
        synced.has("companies") ? Promise.resolve() : syncSafe(() => syncCompanies(accountId, client), "companies"),
        synced.has("tasks") ? Promise.resolve() : syncSafe(() => syncTasks(accountId, client), "tasks"),
      ]);

      await job.updateProgress(80);
      // Notes and events also independent — run in parallel
      await Promise.all([
        synced.has("notes") ? Promise.resolve() : syncSafe(() => syncNotes(accountId, client), "notes"),
        synced.has("events") ? Promise.resolve() : syncSafe(() => syncEvents(accountId, client), "events"),
      ]);

      await db
        .update(accounts)
        .set({ syncStatus: "ready", updatedAt: new Date() })
        .where(eq(accounts.id, accountId));

      await job.updateProgress(100);
      console.log(`[full-sync] Completed for ${subdomain}`);

      // Enqueue embedding jobs for notes and deals (background, low priority)
      try {
        const { enqueueUnembeddedNotes, enqueueUnembeddedDeals } = await import(
          "../embeddings/embed.worker.js"
        );
        const [noteCount, dealCount] = await Promise.all([
          enqueueUnembeddedNotes(accountId),
          enqueueUnembeddedDeals(accountId),
        ]);
        if (noteCount + dealCount > 0) {
          console.log(`[full-sync] Queued ${noteCount} note + ${dealCount} deal embeddings`);
        }
      } catch {
        // Non-fatal — embeddings can be enqueued later
      }
    } catch (err) {
      await db
        .update(accounts)
        .set({ syncStatus: "error", updatedAt: new Date() })
        .where(eq(accounts.id, accountId));
      throw err;
    }
}

// ─── Helper: ignore 404 from AmoCRM (empty account has no data) ──────────────

async function syncSafe(fn: () => Promise<void>, name: string): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status;
    if (status === 404) {
      console.log(`[full-sync] ${name}: no data (404) — skipping`);
    } else {
      throw err;
    }
  }
}

// ─── Sync functions ───────────────────────────────────────────────────────────

async function syncUsers(accountId: string, client: ReturnType<typeof getAmoClient>) {
  const page = await client.getUsers();
  const amoUsers: AmoUser[] = page._embedded?.users ?? [];
  if (amoUsers.length === 0) return;

  await db
    .insert(users)
    .values(
      amoUsers.map((u) => ({
        accountId,
        amoId: u.id,
        name: u.name,
        email: u.email ?? null,
        role: u.role?.name ?? null,
        isActive: u.is_active ?? true,
      }))
    )
    .onConflictDoUpdate({
      target: [users.accountId, users.amoId],
      set: {
        name: sql`excluded.name`,
        email: sql`excluded.email`,
        role: sql`excluded.role`,
        isActive: sql`excluded.is_active`,
        updatedAt: new Date(),
      },
    });

  await updateSyncCursor(accountId, "users", Math.floor(Date.now() / 1000), amoUsers.length);
  console.log(`[sync:users] ${amoUsers.length} users`);
}

async function syncPipelines(accountId: string, client: ReturnType<typeof getAmoClient>) {
  const page = await client.getPipelines();
  const amoPipelines: AmoPipeline[] = page._embedded?.pipelines ?? [];

  for (const p of amoPipelines) {
    const [pipeline] = await db
      .insert(pipelines)
      .values({
        accountId,
        amoId: p.id,
        name: p.name,
        isMain: p.is_main,
        isDeleted: p.is_deleted ?? false,
        sort: p.sort,
      })
      .onConflictDoUpdate({
        target: [pipelines.accountId, pipelines.amoId],
        set: {
          name: sql`excluded.name`,
          isMain: sql`excluded.is_main`,
          isDeleted: sql`excluded.is_deleted`,
          sort: sql`excluded.sort`,
        },
      })
      .returning({ id: pipelines.id });

    const stages = p._embedded?.statuses ?? [];
    if (stages.length > 0) {
      await db
        .insert(pipelineStages)
        .values(
          stages.map((s) => ({
            accountId,
            pipelineId: pipeline.id,
            amoId: s.id,
            name: s.name,
            sort: s.sort,
            type: s.type,
            color: s.color ?? null,
            isDeleted: false,
          }))
        )
        .onConflictDoUpdate({
          target: [pipelineStages.accountId, pipelineStages.amoId],
          set: {
            name: sql`excluded.name`,
            sort: sql`excluded.sort`,
            type: sql`excluded.type`,
            color: sql`excluded.color`,
          },
        });
    }
  }

  await updateSyncCursor(accountId, "pipelines", Math.floor(Date.now() / 1000), amoPipelines.length);
  console.log(`[sync:pipelines] ${amoPipelines.length} pipelines`);
}

async function syncCustomFields(accountId: string, client: ReturnType<typeof getAmoClient>) {
  for (const entityType of ["leads", "contacts", "companies", "tasks"] as const) {
    let count = 0;
    for await (const batch of client.getCustomFields(entityType)) {
      const fields: AmoCustomField[] = batch;
      await db
        .insert(customFieldDefinitions)
        .values(
          fields.map((f) => ({
            accountId,
            amoId: f.id,
            entityType,
            name: f.name,
            fieldType: f.type,
            sort: f.sort,
            isSystem: f.is_system ?? false,
            enums: f.enums ?? null,
          }))
        )
        .onConflictDoUpdate({
          target: [customFieldDefinitions.accountId, customFieldDefinitions.amoId],
          set: {
            name: sql`excluded.name`,
            fieldType: sql`excluded.field_type`,
            enums: sql`excluded.enums`,
          },
        });
      count += fields.length;
    }
    console.log(`[sync:custom_fields] ${entityType}: ${count}`);
  }
  await updateSyncCursor(accountId, "custom_fields", Math.floor(Date.now() / 1000), 0);
}

async function syncDeals(accountId: string, client: ReturnType<typeof getAmoClient>) {
  let count = 0;
  let maxUpdatedAt = 0;

  for await (const batch of client.getDeals()) {
    const amoDeals: AmoDeal[] = batch;
    await db
      .insert(deals)
      .values(
        amoDeals.map((d) => ({
          accountId,
          amoId: d.id,
          name: d.name ?? null,
          price: d.price?.toString() ?? "0",
          statusId: d.status_id,
          pipelineAmoId: d.pipeline_id,
          stageAmoId: d.status_id,
          responsibleUserAmoId: d.responsible_user_id,
          customFields: d.custom_fields_values ?? null,
          tags: d._embedded?.tags?.map((t) => t.name) ?? null,
          isDeleted: d.is_deleted ?? false,
          closedStatus: d.status_id === 142 ? 1 : d.status_id === 143 ? 2 : 0,
          createdAt: unixToDate(d.created_at),
          updatedAt: unixToDate(d.updated_at),
          closedAt: unixToDate(d.closed_at ?? undefined),
        }))
      )
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

    const batchMax = getMaxUpdatedAt(amoDeals);
    if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
    count += amoDeals.length;
    if (count % 1000 === 0) console.log(`[sync:deals] ${count}...`);
  }

  await updateSyncCursor(accountId, "leads", maxUpdatedAt, count);
  console.log(`[sync:deals] Total: ${count}`);
}

async function syncContacts(accountId: string, client: ReturnType<typeof getAmoClient>) {
  let count = 0;
  let maxUpdatedAt = 0;

  for await (const batch of client.getContacts()) {
    const items: AmoContact[] = batch;
    await db
      .insert(contacts)
      .values(
        items.map((c) => ({
          accountId,
          amoId: c.id,
          name: c.name ?? null,
          responsibleUserAmoId: c.responsible_user_id,
          customFields: c.custom_fields_values ?? null,
          isDeleted: c.is_deleted ?? false,
          createdAt: unixToDate(c.created_at),
          updatedAt: unixToDate(c.updated_at),
        }))
      )
      .onConflictDoUpdate({
        target: [contacts.accountId, contacts.amoId],
        set: {
          name: sql`excluded.name`,
          responsibleUserAmoId: sql`excluded.responsible_user_amo_id`,
          customFields: sql`excluded.custom_fields`,
          isDeleted: sql`excluded.is_deleted`,
          updatedAt: sql`excluded.updated_at`,
          syncedAt: new Date(),
        },
      });

    const batchMax = getMaxUpdatedAt(items);
    if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
    count += items.length;
  }

  await updateSyncCursor(accountId, "contacts", maxUpdatedAt, count);
  console.log(`[sync:contacts] Total: ${count}`);
}

async function syncCompanies(accountId: string, client: ReturnType<typeof getAmoClient>) {
  let count = 0;
  let maxUpdatedAt = 0;

  for await (const batch of client.getCompanies()) {
    const items = batch;
    await db
      .insert(companies)
      .values(
        items.map((c) => ({
          accountId,
          amoId: c.id,
          name: c.name ?? null,
          responsibleUserAmoId: c.responsible_user_id,
          customFields: c.custom_fields_values ?? null,
          isDeleted: c.is_deleted ?? false,
          createdAt: unixToDate(c.created_at),
          updatedAt: unixToDate(c.updated_at),
        }))
      )
      .onConflictDoUpdate({
        target: [companies.accountId, companies.amoId],
        set: {
          name: sql`excluded.name`,
          responsibleUserAmoId: sql`excluded.responsible_user_amo_id`,
          customFields: sql`excluded.custom_fields`,
          isDeleted: sql`excluded.is_deleted`,
          updatedAt: sql`excluded.updated_at`,
          syncedAt: new Date(),
        },
      });

    const batchMax = getMaxUpdatedAt(items);
    if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
    count += items.length;
  }

  await updateSyncCursor(accountId, "companies", maxUpdatedAt, count);
  console.log(`[sync:companies] Total: ${count}`);
}

async function syncTasks(accountId: string, client: ReturnType<typeof getAmoClient>) {
  let count = 0;
  let maxUpdatedAt = 0;

  // Only sync active (incomplete) tasks — completed tasks are frozen and won't change.
  // This reduces 418k → ~17k records (96% faster).
  for await (const batch of client.getTasks({ "filter[is_completed]": 0 })) {
    const items: AmoTask[] = batch;
    await db
      .insert(tasks)
      .values(
        items.map((t) => ({
          accountId,
          amoId: t.id,
          entityType: toEntityType(t.entity_type),
          entityAmoId: t.entity_id,
          responsibleUserAmoId: t.responsible_user_id,
          taskTypeId: t.task_type_id,
          text: t.text ?? null,
          completeTill: unixToDate(t.complete_till),
          isCompleted: t.is_completed ?? false,
          createdAt: unixToDate(t.created_at),
          updatedAt: unixToDate(t.updated_at),
        }))
      )
      .onConflictDoUpdate({
        target: [tasks.accountId, tasks.amoId],
        set: {
          isCompleted: sql`excluded.is_completed`,
          completedAt: sql`excluded.completed_at`,
          updatedAt: sql`excluded.updated_at`,
          syncedAt: new Date(),
        },
      });

    const batchMax = getMaxUpdatedAt(items);
    if (batchMax > maxUpdatedAt) maxUpdatedAt = batchMax;
    count += items.length;
    if (count % 5000 === 0) console.log(`[sync:tasks] ${count}...`);
  }

  await updateSyncCursor(accountId, "tasks", maxUpdatedAt, count);
  console.log(`[sync:tasks] Total: ${count}`);
}

async function syncNotes(accountId: string, client: ReturnType<typeof getAmoClient>) {
  let count = 0;

  // Only sync lead notes in initial sync — contact notes are lower priority
  // and 52k contacts can have 100k+ notes (too slow for initial load).
  for await (const batch of client.getNotes("leads")) {
    const items: AmoNote[] = batch;
    await db
      .insert(notes)
      .values(
        items.map((n) => ({
          accountId,
          amoId: n.id,
          entityType: toEntityType(n.entity_type),
          entityAmoId: n.entity_id,
          responsibleUserAmoId: n.responsible_user_id,
          noteType: toNoteType(n.note_type),
          content: n.params,
          textContent: extractNoteText(n),
          createdAt: unixToDate(n.created_at),
          updatedAt: unixToDate(n.updated_at),
        }))
      )
      .onConflictDoUpdate({
        target: [notes.accountId, notes.amoId],
        set: {
          content: sql`excluded.content`,
          textContent: sql`excluded.text_content`,
          updatedAt: sql`excluded.updated_at`,
          syncedAt: new Date(),
        },
      });
    count += items.length;
    if (count % 5000 === 0) console.log(`[sync:notes] ${count}...`);
  }

  await updateSyncCursor(accountId, "notes", Math.floor(Date.now() / 1000), count);
  console.log(`[sync:notes] Total: ${count}`);
}

async function syncEvents(accountId: string, client: ReturnType<typeof getAmoClient>) {
  let count = 0;

  // Limit initial sync to last 6 months — older history can be fetched later
  // if needed. A full history of a large account can be 1M+ events.
  const sixMonthsAgo = Math.floor(Date.now() / 1000) - 6 * 30 * 24 * 3600;

  for await (const batch of client.getEvents({ "filter[created_at][from]": sixMonthsAgo })) {
    const items: AmoEvent[] = batch;
    const eventRows = items
      .filter((e) => e.entity_type === "lead" || e.entity_type === "leads")
      .map((e) => ({
        accountId,
        dealAmoId: e.entity_id,
        eventType: mapEventType(e.type),
        fromValue: e.value_before ? JSON.stringify(e.value_before) : null,
        toValue: e.value_after ? JSON.stringify(e.value_after) : null,
        userAmoId: e.created_by,
        occurredAt: unixToDate(e.created_at) ?? new Date(),
      }));

    if (eventRows.length > 0) {
      await db.insert(dealEvents).values(eventRows).onConflictDoNothing();
    }
    count += items.length;
    if (count % 5000 === 0) console.log(`[sync:events] ${count}...`);
  }

  await updateSyncCursor(accountId, "events", Math.floor(Date.now() / 1000), count);
  console.log(`[sync:events] Total: ${count}`);
}

const KNOWN_NOTE_TYPES = new Set([
  "common", "call_in", "call_out", "service_message", "message_cashier",
  "extended_service_message", "geolocation_message", "invoice_message",
  "ai_activity", "mail_message",
]);

type NoteTypeValue = "common" | "call_in" | "call_out" | "service_message" | "message_cashier" | "extended_service_message" | "geolocation_message" | "invoice_message" | "ai_activity" | "mail_message";

function toNoteType(raw: string | undefined): NoteTypeValue {
  return (raw && KNOWN_NOTE_TYPES.has(raw) ? raw : "common") as NoteTypeValue;
}

function extractNoteText(note: AmoNote): string | null {
  const params = note.params as Record<string, unknown>;
  if (typeof params?.text === "string") return params.text;
  if (typeof params?.call_result === "string") return params.call_result;
  return null;
}

type DealEventType = "created" | "status_change" | "responsible_change" | "price_change" | "won" | "lost" | "deleted" | "restored" | "field_change";

function mapEventType(type: string): DealEventType {
  const map: Record<string, DealEventType> = {
    lead_added: "created",
    lead_status_changed: "status_change",
    lead_responsible_changed: "responsible_change",
    lead_price_changed: "price_change",
    lead_deleted: "deleted",
    lead_restored: "restored",
  };
  return map[type] ?? "field_change";
}
