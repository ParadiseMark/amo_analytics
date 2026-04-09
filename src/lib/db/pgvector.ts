/**
 * pgvector setup and migration.
 * Runs at startup to ensure the extension and columns exist.
 */
import { db } from "./index.js";
import { sql } from "drizzle-orm";

export async function applyPgvectorMigration(): Promise<void> {
  // Install extension (requires superuser, or it should be pre-installed)
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch {
    // Extension may already exist or be pre-installed; continue
  }

  // Add embedding columns if they don't exist yet
  await db.execute(sql`
    ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS embedding vector(1536)
  `);

  await db.execute(sql`
    ALTER TABLE deals
    ADD COLUMN IF NOT EXISTS embedding vector(1536)
  `);

  // HNSW index on notes for fast approximate nearest-neighbor search
  // CREATE INDEX CONCURRENTLY is not allowed in transactions — use IF NOT EXISTS
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS notes_embedding_hnsw
    ON notes USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS deals_embedding_hnsw
    ON deals USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  console.log("[pgvector] Migration applied");
}
