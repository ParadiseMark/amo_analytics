/**
 * Запускает все per-account BullMQ workers при старте сервера.
 *
 * Каждый аккаунт с syncStatus='ready' получает:
 *   - sync worker         (full-sync + incremental-sync)
 *   - metrics worker      (KPI recompute)
 *   - analytics worker    (bottleneck detection, profiles)
 *   - embedding worker    (pgvector, только если OPENAI_API_KEY есть)
 *
 * Также запускается глобальный webhook worker (один на всю систему).
 */
import { db } from "../lib/db/index.js";
import { accounts } from "../lib/db/schema.js";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { createSyncWorker } from "./sync/full-sync.worker.js";
import { createMetricsWorker } from "./metrics/metrics.worker.js";
import { startAnalyticsWorker } from "./analytics/analytics.worker.js";
import { createEmbeddingWorker } from "./embeddings/embed.worker.js";
import { webhookProcessWorker } from "./sync/webhook-process.worker.js";

export async function bootstrapAllWorkers(): Promise<void> {
  // Глобальный webhook worker — один на всю систему
  // Просто импортом запускается (Worker инициализируется при импорте)
  void webhookProcessWorker;

  const activeAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.syncStatus, "ready"));

  for (const { id } of activeAccounts) {
    startWorkersForAccount(id);
  }

  console.log(
    `[bootstrap] Workers запущены для ${activeAccounts.length} аккаунт(ов)` +
    (env.OPENAI_API_KEY ? " (embeddings включены)" : "")
  );
}

/** Запускает все workers для одного аккаунта. Вызывается при подключении нового аккаунта. */
export function startWorkersForAccount(accountId: string): void {
  createSyncWorker(accountId);
  createMetricsWorker(accountId);
  startAnalyticsWorker(accountId);
  if (env.OPENAI_API_KEY) {
    createEmbeddingWorker(accountId);
  }
}
