/**
 * Embeddings worker — generates OpenAI text-embedding-3-small vectors for notes
 * and deal descriptions, stores them in pgvector column.
 *
 * Each job processes a single entity (batch dispatch from full-sync / incremental).
 * Rate: OpenAI embeddings API is very generous (~3000 RPM on tier-1).
 */
import { Worker } from "bullmq";
import { redis } from "../../lib/redis/index.js";
import { db } from "../../lib/db/index.js";
import { notes, deals } from "../../lib/db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { EmbeddingJobData } from "../../lib/queue/queues.js";

// ─── OpenAI embeddings (simple fetch, no SDK needed) ─────────────────────────

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS  = 1536;

async function createEmbedding(text: string): Promise<number[]> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text.slice(0, 8191), // token limit safety
      dimensions: EMBED_DIMS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings API error ${res.status}: ${body}`);
  }

  const data = await res.json() as { data: [{ embedding: number[] }] };
  return data.data[0].embedding;
}

// ─── Store vector using pgvector syntax ──────────────────────────────────────

async function storeNoteEmbedding(entityId: number, vector: number[]): Promise<void> {
  // pgvector expects '[1.0,2.0,...]' string format
  const vecStr = `[${vector.join(",")}]`;
  await db.execute(
    sql`UPDATE notes SET embedding = ${vecStr}::vector WHERE id = ${entityId}`
  );
}

async function storeDealEmbedding(entityId: number, vector: number[]): Promise<void> {
  const vecStr = `[${vector.join(",")}]`;
  await db.execute(
    sql`UPDATE deals SET embedding = ${vecStr}::vector WHERE id = ${entityId}`
  );
}

// ─── Worker factory ───────────────────────────────────────────────────────────

export function createEmbeddingWorker(accountId: string): Worker<EmbeddingJobData> {
  const queueName = `embeddings-${accountId}`;

  return new Worker<EmbeddingJobData>(
    queueName,
    async (job) => {
      const { entityType, entityId, text } = job.data;

      if (!text?.trim()) return; // nothing to embed

      const vector = await createEmbedding(text);

      if (entityType === "notes") {
        await storeNoteEmbedding(entityId, vector);
      } else if (entityType === "deals") {
        await storeDealEmbedding(entityId, vector);
      }
    },
    {
      connection: redis,
      concurrency: 5,        // 5 parallel embedding calls per account
      limiter: { max: 50, duration: 60_000 }, // 50 req/min per account (well below OpenAI limit)
    }
  );
}

// ─── Batch: enqueue all unembedded notes for an account ──────────────────────

export async function enqueueUnembeddedNotes(accountId: string): Promise<number> {
  const { getEmbeddingQueue } = await import("../../lib/queue/queues.js");
  const queue = getEmbeddingQueue(accountId);

  // Find notes without embeddings that have text content
  const unembedded = await db.execute<{ id: number; text_content: string }>(sql`
    SELECT id, text_content
    FROM notes
    WHERE account_id = ${accountId}
      AND text_content IS NOT NULL
      AND text_content != ''
      AND embedding IS NULL
    LIMIT 500
  `);

  const rows = unembedded.rows as { id: number; text_content: string }[];
  if (rows.length === 0) return 0;

  await Promise.all(
    rows.map((row) =>
      queue.add(
        "embed-note",
        {
          accountId,
          entityType: "notes",
          entityId: row.id,
          text: row.text_content,
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          jobId: `embed:note:${row.id}`,
        }
      )
    )
  );

  return rows.length;
}

// ─── Batch: enqueue all unembedded deals (name + description) ─────────────────

export async function enqueueUnembeddedDeals(accountId: string): Promise<number> {
  const { getEmbeddingQueue } = await import("../../lib/queue/queues.js");
  const queue = getEmbeddingQueue(accountId);

  const unembedded = await db.execute<{ id: number; name: string | null; custom_fields: unknown }>(sql`
    SELECT id, name, custom_fields
    FROM deals
    WHERE account_id = ${accountId}
      AND embedding IS NULL
      AND is_deleted = false
    LIMIT 500
  `);

  const rows = unembedded.rows as { id: number; name: string | null }[];
  if (rows.length === 0) return 0;

  await Promise.all(
    rows
      .filter((r) => r.name?.trim())
      .map((row) =>
        queue.add(
          "embed-deal",
          {
            accountId,
            entityType: "deals",
            entityId: row.id,
            text: row.name!,
          },
          {
            attempts: 3,
            backoff: { type: "exponential", delay: 5_000 },
            jobId: `embed:deal:${row.id}`,
          }
        )
      )
  );

  return rows.length;
}
