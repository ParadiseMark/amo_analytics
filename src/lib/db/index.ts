import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../../config/env.js";
import * as schema from "./schema.js";

const { Pool } = pg;

// Supabase requires SSL. For pooler (transaction mode) add ?pgbouncer=true to URL.
// Runtime app uses DATABASE_URL (can be pooler URL for better connection reuse).
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 600_000,       // 10 min — don't drop idle connections too fast
  connectionTimeoutMillis: 15_000,
  // TCP keepalive — prevents Supabase/load-balancer from silently dropping long-running connections
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: env.DATABASE_URL.includes("supabase.co") || env.DATABASE_URL.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : false,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

export async function checkDbConnection(): Promise<void> {
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
}
