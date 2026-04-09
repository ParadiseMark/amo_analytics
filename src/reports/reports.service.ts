/**
 * Report service — CRUD + execution.
 */
import { db } from "../lib/db/index.js";
import { reportDefinitions, reportSnapshots } from "../lib/db/schema.js";
import { and, eq, desc } from "drizzle-orm";
import { query } from "../lib/clickhouse/index.js";
import { ReportDslSchema, type ReportDsl } from "./dsl.js";
import { translateDsl, DslTranslationError } from "./translator.js";
import { redisCache } from "../lib/redis/index.js";
import { createHash } from "crypto";

const SNAPSHOT_CACHE_TTL = 60 * 30; // 30 minutes

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createReport(
  accountId: string,
  createdBy: string,
  dslInput: unknown
): Promise<typeof reportDefinitions.$inferSelect> {
  const dsl = ReportDslSchema.parse(dslInput);

  // Validate the DSL translates without errors before saving
  translateDsl(dsl, accountId);

  const [report] = await db
    .insert(reportDefinitions)
    .values({
      accountId,
      name: dsl.name,
      description: dsl.description ?? null,
      config: dsl as any,
      createdByPlatformUserId: createdBy,
    })
    .returning();

  return report;
}

export async function updateReport(
  accountId: string,
  reportId: string,
  dslInput: unknown
): Promise<typeof reportDefinitions.$inferSelect | null> {
  const dsl = ReportDslSchema.parse(dslInput);
  translateDsl(dsl, accountId); // validate

  const [updated] = await db
    .update(reportDefinitions)
    .set({
      name: dsl.name,
      description: dsl.description ?? null,
      config: dsl as any,
      updatedAt: new Date(),
    })
    .where(and(eq(reportDefinitions.id, reportId), eq(reportDefinitions.accountId, accountId)))
    .returning();

  return updated ?? null;
}

export async function deleteReport(accountId: string, reportId: string): Promise<void> {
  await db
    .delete(reportDefinitions)
    .where(and(eq(reportDefinitions.id, reportId), eq(reportDefinitions.accountId, accountId)));
}

export async function listReports(accountId: string) {
  return db.query.reportDefinitions.findMany({
    where: eq(reportDefinitions.accountId, accountId),
    orderBy: [desc(reportDefinitions.updatedAt)],
    columns: {
      id: true,
      name: true,
      description: true,
      createdByPlatformUserId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getReport(accountId: string, reportId: string) {
  return db.query.reportDefinitions.findFirst({
    where: and(eq(reportDefinitions.id, reportId), eq(reportDefinitions.accountId, accountId)),
  });
}

// ─── Execution ────────────────────────────────────────────────────────────────

export type ReportResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs: number;
  cachedAt?: string;
  fromCache: boolean;
};

export async function runReport(
  accountId: string,
  reportId: string,
  forceRefresh = false
): Promise<ReportResult> {
  const report = await getReport(accountId, reportId);
  if (!report) throw new Error(`Report ${reportId} not found`);

  const dsl = ReportDslSchema.parse(report.config);
  const cacheKey = `report:${accountId}:${reportId}:${hashDsl(dsl)}`;

  if (!forceRefresh) {
    const cached = await redisCache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as ReportResult;
      return { ...parsed, fromCache: true };
    }
  }

  const { sql: sqlStr, params } = translateDsl(dsl, accountId);

  const start = Date.now();
  const rows = await query<Record<string, unknown>>(sqlStr, params);
  const executionMs = Date.now() - start;

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const result: ReportResult = { columns, rows, executionMs, fromCache: false };

  // Cache result
  await redisCache.setex(cacheKey, SNAPSHOT_CACHE_TTL, JSON.stringify(result));

  // Persist snapshot for history
  await db.insert(reportSnapshots).values({
    reportId,
    data: { columns, rows: rows.slice(0, 500), executionMs, rowCount: rows.length },
  });

  return result;
}

// ─── Preview (no persistence) ─────────────────────────────────────────────────

export async function previewReport(
  accountId: string,
  dslInput: unknown
): Promise<ReportResult> {
  const dsl = ReportDslSchema.parse(dslInput);
  // Override limit for preview
  const previewDsl: ReportDsl = { ...dsl, limit: Math.min(dsl.limit, 20) };

  const { sql: sqlStr, params } = translateDsl(previewDsl, accountId);

  const start = Date.now();
  const rows = await query<Record<string, unknown>>(sqlStr, params);
  const executionMs = Date.now() - start;

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, executionMs, fromCache: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashDsl(dsl: ReportDsl): string {
  return createHash("sha256")
    .update(JSON.stringify(dsl))
    .digest("hex")
    .substring(0, 12);
}
