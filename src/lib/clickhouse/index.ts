import { createClient } from "@clickhouse/client";
import { env } from "../../config/env.js";

export const ch = createClient({
  url: env.CLICKHOUSE_HOST,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
  database: env.CLICKHOUSE_DB,
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 0,
  },
});

export async function checkClickHouseConnection(): Promise<void> {
  await ch.ping();
}

// Helper: execute DDL
export async function exec(query: string): Promise<void> {
  await ch.exec({ query });
}

// Helper: insert rows
export async function insert<T extends Record<string, unknown>>(
  table: string,
  values: T[]
): Promise<void> {
  if (values.length === 0) return;
  await ch.insert({ table, values, format: "JSONEachRow" });
}

// Helper: query rows
export async function query<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  const result = await ch.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<T>();
}
