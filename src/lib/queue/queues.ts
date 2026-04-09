import { Queue, Worker, QueueEvents } from "bullmq";
import { redis } from "../redis/index.js";

// ─── Job type definitions ─────────────────────────────────────────────────────

export type FullSyncJobData = {
  accountId: string;
  subdomain: string;
  entityTypes?: EntityType[];
};

export type IncrementalSyncJobData = {
  accountId: string;
  subdomain: string;
  entityType: EntityType;
  fromTimestamp: number;
};

export type WebhookProcessJobData = {
  accountId: string;
  subdomain: string;
  entityType: EntityType;
  entityAmoId: number;
  eventType: string;
  rawPayload: Record<string, unknown>;
};

export type MetricsComputeJobData = {
  accountId: string;
  userAmoId?: number; // if undefined — recompute all managers
  date?: string; // YYYY-MM-DD, if undefined — recompute last 7 days
};

export type EmbeddingJobData = {
  accountId: string;
  entityType: "notes" | "deals";
  entityId: number;
  text: string;
};

export type EntityType =
  | "users"
  | "pipelines"
  | "custom_fields"
  | "leads"
  | "contacts"
  | "companies"
  | "tasks"
  | "notes"
  | "calls"
  | "events";

// ─── Queue factory ─────────────────────────────────────────────────────────────

function makeQueue<T>(name: string, accountId?: string) {
  const queueName = accountId ? `${name}-${accountId}` : name;
  return new Queue<T>(queueName, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
}

// ─── Singleton queue instances per account ─────────────────────────────────────

const syncQueues = new Map<string, Queue<FullSyncJobData | IncrementalSyncJobData>>();
const metricsQueues = new Map<string, Queue<MetricsComputeJobData>>();
const embeddingQueues = new Map<string, Queue<EmbeddingJobData>>();

// Global webhook queue (all accounts share one for ordering)
export const webhookQueue = makeQueue<WebhookProcessJobData>("webhook");

export function getSyncQueue(accountId: string) {
  if (!syncQueues.has(accountId)) {
    syncQueues.set(accountId, makeQueue(`sync`, accountId));
  }
  return syncQueues.get(accountId)!;
}

export function getMetricsQueue(accountId: string) {
  if (!metricsQueues.has(accountId)) {
    metricsQueues.set(
      accountId,
      makeQueue<MetricsComputeJobData>(`metrics`, accountId)
    );
  }
  return metricsQueues.get(accountId)!;
}

export function getEmbeddingQueue(accountId: string) {
  if (!embeddingQueues.has(accountId)) {
    embeddingQueues.set(
      accountId,
      makeQueue<EmbeddingJobData>(`embeddings`, accountId)
    );
  }
  return embeddingQueues.get(accountId)!;
}

// ─── Convenience: enqueue full sync ──────────────────────────────────────────

export async function enqueueFullSync(accountId: string, subdomain: string) {
  const queue = getSyncQueue(accountId);
  await queue.add(
    "full-sync",
    { accountId, subdomain },
    {
      priority: 10, // lower number = higher priority (incremental gets 1)
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    }
  );
}

export async function enqueueIncrementalSync(
  accountId: string,
  subdomain: string,
  entityType: EntityType,
  fromTimestamp: number
) {
  const queue = getSyncQueue(accountId);
  await queue.add(
    "incremental-sync",
    { accountId, subdomain, entityType, fromTimestamp },
    {
      priority: 1, // high priority
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      jobId: `inc-sync-${accountId}-${entityType}`, // deduplicate
    }
  );
}

export async function enqueueWebhookProcess(data: WebhookProcessJobData) {
  await webhookQueue.add("process", data, {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
    // Deduplicate by entity+event within 5s window
    jobId: `wh:${data.accountId}:${data.entityType}:${data.entityAmoId}:${data.eventType}:${Math.floor(Date.now() / 5000)}`,
  });
}

export async function enqueueMetricsCompute(data: MetricsComputeJobData) {
  const queue = getMetricsQueue(data.accountId);
  await queue.add("compute", data, {
    attempts: 3,
    backoff: { type: "fixed", delay: 3_000 },
    jobId: `metrics-${data.accountId}-${data.userAmoId ?? "all"}-${data.date ?? "recent"}`,
  });
}
