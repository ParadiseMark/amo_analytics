import { eq, and } from "drizzle-orm";
import { db } from "../../lib/db/index.js";
import { syncCursors } from "../../lib/db/schema.js";

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

export async function getSyncCursor(
  accountId: string,
  entityType: EntityType
): Promise<number | null> {
  const cursor = await db.query.syncCursors.findFirst({
    where: and(
      eq(syncCursors.accountId, accountId),
      eq(syncCursors.entityType, entityType)
    ),
  });
  return cursor?.lastAmoUpdatedAt ?? null;
}

export async function updateSyncCursor(
  accountId: string,
  entityType: EntityType,
  lastAmoUpdatedAt: number,
  totalSynced: number,
  status: "running" | "idle" | "error" = "idle"
): Promise<void> {
  await db
    .insert(syncCursors)
    .values({
      accountId,
      entityType,
      lastAmoUpdatedAt,
      lastSyncedAt: new Date(),
      totalSynced,
      status,
    })
    .onConflictDoUpdate({
      target: [syncCursors.accountId, syncCursors.entityType],
      set: {
        lastAmoUpdatedAt,
        lastSyncedAt: new Date(),
        totalSynced,
        status,
      },
    });
}

// Convert Unix timestamp to Date or null
export function unixToDate(ts: number | null | undefined): Date | null {
  if (!ts) return null;
  return new Date(ts * 1000);
}

// Get max updated_at from a list of items
export function getMaxUpdatedAt<T extends { updated_at?: number; created_at?: number }>(
  items: T[]
): number {
  return items.reduce((max, item) => {
    const ts = item.updated_at ?? item.created_at ?? 0;
    return ts > max ? ts : max;
  }, 0);
}

type EntityTypeValue = "leads" | "contacts" | "companies" | "tasks";

// Narrow a string to a valid entity_type enum value
export function toEntityType(val: string | undefined): EntityTypeValue | null {
  const valid: readonly string[] = ["leads", "contacts", "companies", "tasks"];
  if (val && valid.includes(val)) return val as EntityTypeValue;
  return null;
}

// Chunk array into batches
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
