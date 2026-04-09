import { Worker } from "bullmq";
import { redis } from "../../lib/redis/index.js";
import { computeManagerKpis, computeFunnelTransitions } from "../../analytics/metrics.service.js";
import type { MetricsComputeJobData } from "../../lib/queue/queues.js";

const workers = new Map<string, Worker>();

/** Запускает metrics worker для конкретного аккаунта. Идемпотентен. */
export function createMetricsWorker(accountId: string): Worker<MetricsComputeJobData> {
  if (workers.has(accountId)) return workers.get(accountId)!;

  const worker = new Worker<MetricsComputeJobData>(
    `metrics-${accountId}`,
    async (job) => {
      const { accountId, userAmoId, date } = job.data;

      const endDate   = date ?? formatDate(new Date());
      const startDate = date ? date : formatDate(daysAgo(7));

      await computeManagerKpis(accountId, { userAmoId, startDate, endDate });
    },
    {
      connection: redis,
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[metrics-worker:${accountId}] Job ${job?.name}/${job?.id} failed:`, err.message);
  });

  workers.set(accountId, worker);
  return worker;
}

export function stopMetricsWorker(accountId: string): Promise<void> | undefined {
  const w = workers.get(accountId);
  if (!w) return;
  workers.delete(accountId);
  return w.close();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
