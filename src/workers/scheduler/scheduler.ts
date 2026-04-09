/**
 * Scheduler — registers all repeatable BullMQ jobs.
 * Called once at startup after DB/Redis are ready.
 *
 * Jobs registered per active account:
 *  - incremental-sync          every 15 min
 *  - bottleneck-detection      every night at 03:00
 *  - profiles-computation      every Monday at 04:00
 *  - nightly-reconciliation    every night at 02:00
 */
import { Queue } from "bullmq";
import { redis } from "../../lib/redis/index.js";
import { db } from "../../lib/db/index.js";
import { accounts } from "../../lib/db/schema.js";
import { eq } from "drizzle-orm";
import { getSyncCursor } from "../sync/sync.utils.js";
import { enqueueIncrementalSync } from "../../lib/queue/queues.js";
import type { EntityType } from "../../lib/queue/queues.js";

const INCREMENTAL_ENTITY_TYPES: EntityType[] = ["leads", "contacts", "tasks"];

// ─── Queue instances (created on demand, cached) ─────────────────────────────

const queueCache = new Map<string, Queue>();

function getQueue(name: string): Queue {
  if (!queueCache.has(name)) {
    queueCache.set(name, new Queue(name, { connection: redis }));
  }
  return queueCache.get(name)!;
}

// ─── Register repeatable jobs for a single account ───────────────────────────

export async function registerAccountJobs(accountId: string): Promise<void> {
  const syncQ      = getQueue(`sync-${accountId}`);
  const analyticsQ = getQueue(`analytics-${accountId}`);

  // Incremental sync trigger — every 15 minutes.
  // Dispatches per-entity incremental sync jobs with proper subdomain + cursor data.
  await syncQ.add(
    "incremental-sync-trigger",
    { accountId },
    {
      jobId: `incremental-sync-trigger-${accountId}`,
      repeat: { pattern: "*/15 * * * *" },
      removeOnComplete: 10,
      removeOnFail: 20,
    }
  );

  // Nightly reconciliation — 02:00 UTC
  await syncQ.add(
    "nightly-reconciliation",
    { accountId },
    {
      jobId: `nightly-reconciliation-${accountId}`,
      repeat: { pattern: "0 2 * * *" },
      removeOnComplete: 5,
      removeOnFail: 10,
    }
  );

  // Bottleneck detection — 03:00 UTC
  await analyticsQ.add(
    "bottleneck-detection",
    { accountId },
    {
      jobId: `bottleneck-detection-${accountId}`,
      repeat: { pattern: "0 3 * * *" },
      removeOnComplete: 5,
      removeOnFail: 10,
    }
  );

  // Manager profiles — every Monday 04:00 UTC
  await analyticsQ.add(
    "profiles-computation",
    { accountId },
    {
      jobId: `profiles-computation-${accountId}`,
      repeat: { pattern: "0 4 * * 1" },
      removeOnComplete: 5,
      removeOnFail: 10,
    }
  );

  // Token expiry check — daily at 08:00 UTC
  await analyticsQ.add(
    "token-expiry-check",
    { accountId },
    {
      jobId: `token-expiry-check-${accountId}`,
      repeat: { pattern: "0 8 * * *" },
      removeOnComplete: 3,
      removeOnFail: 5,
    }
  );

  console.log(`[scheduler] Jobs registered for account=${accountId}`);
}

// ─── Trigger incremental sync for all entity types ───────────────────────────

/**
 * Looks up the account subdomain + per-entity cursors, then enqueues one
 * incremental-sync job per entity type.  Called by the sync worker when it
 * receives an "incremental-sync-trigger" job from the scheduler.
 */
export async function triggerIncrementalSync(accountId: string): Promise<void> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
    columns: { subdomain: true },
  });
  if (!account) {
    console.warn(`[scheduler] triggerIncrementalSync: account ${accountId} not found`);
    return;
  }

  for (const entityType of INCREMENTAL_ENTITY_TYPES) {
    const cursor = await getSyncCursor(accountId, entityType);
    const fromTimestamp = cursor ?? Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
    await enqueueIncrementalSync(accountId, account.subdomain, entityType, fromTimestamp);
  }
}

// ─── Remove all repeatable jobs for a disconnected account ───────────────────

export async function unregisterAccountJobs(accountId: string): Promise<void> {
  const syncQ      = getQueue(`sync-${accountId}`);
  const analyticsQ = getQueue(`analytics-${accountId}`);

  const queues = [syncQ, analyticsQ];
  for (const q of queues) {
    const repeatableJobs = await q.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await q.removeRepeatableByKey(job.key);
    }
    await q.close();
    queueCache.delete(q.name);
  }

  console.log(`[scheduler] Jobs unregistered for account=${accountId}`);
}

// ─── Bootstrap — register jobs for all active accounts ───────────────────────

export async function bootstrapScheduler(): Promise<void> {
  const activeAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.syncStatus, "ready"));

  console.log(`[scheduler] Bootstrapping ${activeAccounts.length} account(s)...`);

  await Promise.all(activeAccounts.map((a) => registerAccountJobs(a.id)));

  console.log("[scheduler] Bootstrap complete");
}
