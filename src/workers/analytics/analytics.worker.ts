/**
 * Analytics worker — handles scheduled analytics jobs:
 *   - bottleneck-detection
 *   - profiles-computation
 *
 * One worker instance per account (instantiated by the scheduler bootstrap).
 */
import { Worker } from "bullmq";
import { redis } from "../../lib/redis/index.js";
import { runBottleneckDetection } from "../../analytics/bottlenecks.service.js";
import { computeManagerProfiles } from "../../analytics/profiles.service.js";
import { runTokenExpiryMonitor } from "../scheduler/token-monitor.js";

type AnalyticsJobData = { accountId: string };

const workers = new Map<string, Worker>();

export function startAnalyticsWorker(accountId: string): Worker {
  if (workers.has(accountId)) return workers.get(accountId)!;

  const worker = new Worker<AnalyticsJobData>(
    `analytics-${accountId}`,
    async (job) => {
      const { accountId } = job.data;

      switch (job.name) {
        case "bottleneck-detection":
          await runBottleneckDetection(accountId);
          break;

        case "profiles-computation":
          await computeManagerProfiles(accountId);
          break;

        case "token-expiry-check":
          // Runs per-account job but the monitor checks all accounts at once;
          // only execute on the first account to avoid duplicate runs
          await runTokenExpiryMonitor();
          break;

        default:
          console.warn(`[analytics-worker] Unknown job: ${job.name}`);
      }
    },
    {
      connection: redis,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[analytics-worker:${accountId}] Job ${job?.name}/${job?.id} failed:`, err.message);
  });

  workers.set(accountId, worker);
  return worker;
}

export function stopAnalyticsWorker(accountId: string): Promise<void> | undefined {
  const worker = workers.get(accountId);
  if (!worker) return;
  workers.delete(accountId);
  return worker.close();
}
