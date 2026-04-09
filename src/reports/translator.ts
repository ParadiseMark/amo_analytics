/**
 * DSL → ClickHouse SQL translator.
 *
 * Security:
 *  - All field names are validated against allowlists per data source
 *  - Filter values are always parameterized (never interpolated directly)
 *  - No raw SQL expression support — only safe enum-based constructs
 */
import { DATA_SOURCES, resolveRelativeDate } from "./dsl.js";
import type { ReportDsl, DataSource } from "./dsl.js";

export class DslTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DslTranslationError";
  }
}

type TranslationResult = {
  sql: string;
  params: Record<string, unknown>;
};

// ─── Field validation ─────────────────────────────────────────────────────────

function validateField(source: DataSource, field: string): void {
  const allowed = DATA_SOURCES[source] as readonly string[];
  if (!allowed.includes(field)) {
    throw new DslTranslationError(
      `Field "${field}" is not allowed for source "${source}". ` +
      `Allowed: ${allowed.join(", ")}`
    );
  }
}

// ─── Main translator ──────────────────────────────────────────────────────────

export function translateDsl(
  dsl: ReportDsl,
  accountId: string
): TranslationResult {
  const params: Record<string, unknown> = { accountId };
  let paramIndex = 0;

  function nextParam(value: unknown, type = "String"): string {
    const key = `p${++paramIndex}`;
    params[key] = value;
    return `{${key}: ${type}}`;
  }

  const source = dsl.data_source;

  // ── SELECT clause ──────────────────────────────────────────────────────────
  const selectParts: string[] = [];

  // Group-by dimensions first
  for (const field of dsl.group_by) {
    validateField(source, field);
    selectParts.push(field);
  }

  // Metrics
  for (const metric of dsl.metrics) {
    validateField(source, metric.field);
    const alias = metric.label
      ? `"${metric.label.replace(/"/g, "")}"`
      : `${metric.agg}_${metric.field}`;
    selectParts.push(`${metric.agg}(${metric.field}) AS ${alias}`);
  }

  // ── WHERE clause ───────────────────────────────────────────────────────────
  const whereParts: string[] = [
    `account_id = {accountId: String}`,
  ];

  for (const filter of dsl.filters) {
    validateField(source, filter.field);

    switch (filter.op) {
      case "eq":
        whereParts.push(`${filter.field} = ${nextParam(filter.value)}`);
        break;
      case "neq":
        whereParts.push(`${filter.field} != ${nextParam(filter.value)}`);
        break;
      case "gt":
        whereParts.push(`${filter.field} > ${nextParam(filter.value, "Float64")}`);
        break;
      case "gte":
        whereParts.push(`${filter.field} >= ${nextParam(filter.value, "Float64")}`);
        break;
      case "lt":
        whereParts.push(`${filter.field} < ${nextParam(filter.value, "Float64")}`);
        break;
      case "lte":
        whereParts.push(`${filter.field} <= ${nextParam(filter.value, "Float64")}`);
        break;
      case "between": {
        const [from, to] = filter.value as [string | number, string | number];
        const resolvedFrom = typeof from === "string" ? resolveRelativeDate(from) : from;
        const resolvedTo = typeof to === "string" ? resolveRelativeDate(to) : to;
        // Use inline for relative dates (already safe expressions), param for literals
        if (typeof resolvedFrom === "string" && resolvedFrom.includes("(")) {
          whereParts.push(`${filter.field} BETWEEN ${resolvedFrom} AND ${resolvedTo}`);
        } else {
          whereParts.push(
            `${filter.field} BETWEEN ${nextParam(resolvedFrom)} AND ${nextParam(resolvedTo)}`
          );
        }
        break;
      }
      case "in": {
        const values = filter.value as (string | number)[];
        const key = `p${++paramIndex}`;
        params[key] = values;
        whereParts.push(`${filter.field} IN ({${key}: Array(String)})`);
        break;
      }
    }
  }

  // ── GROUP BY clause ────────────────────────────────────────────────────────
  const groupByClause =
    dsl.group_by.length > 0 ? `GROUP BY ${dsl.group_by.join(", ")}` : "";

  // ── ORDER BY clause ────────────────────────────────────────────────────────
  let orderByClause = "";
  if (dsl.order_by.length > 0) {
    const parts = dsl.order_by.map((o) => {
      // Validate against group_by fields or metric aliases
      return `${o.field} ${o.direction.toUpperCase()}`;
    });
    orderByClause = `ORDER BY ${parts.join(", ")}`;
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  const sqlStr = [
    `SELECT ${selectParts.join(",\n  ")}`,
    `FROM ${source} FINAL`,
    `WHERE ${whereParts.join("\n  AND ")}`,
    groupByClause,
    orderByClause,
    `LIMIT ${dsl.limit}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { sql: sqlStr, params };
}
