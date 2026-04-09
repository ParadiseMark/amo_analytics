/**
 * PostgreSQL Row-Level Security policies.
 * Run once after initial schema migration.
 *
 * Strategy:
 *   - All tenant-scoped tables have a policy: account_id = current_setting('app.current_account_id')
 *   - The application sets this setting per-query via setAccountContext()
 *   - Platform-level tables (platform_users, accounts) use separate policies
 *   - A superuser/migration role bypasses RLS via BYPASSRLS attribute
 */
import { db } from "./index.js";
import { sql } from "drizzle-orm";

// Tables that hold per-account data
const TENANT_TABLES = [
  "users",
  "pipelines",
  "pipeline_stages",
  "custom_field_definitions",
  "deals",
  "contacts",
  "companies",
  "tasks",
  "notes",
  "calls",
  "deal_events",
  "sync_cursors",
  "report_definitions",
  "bottleneck_alerts",
] as const;

export async function applyRlsPolicies(): Promise<void> {
  // Enable RLS on each tenant table and create the restrictive policy
  for (const table of TENANT_TABLES) {
    await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));

    // Drop existing policy if re-running
    await db.execute(
      sql.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`)
    );

    // Allow rows only when account_id matches the session setting
    await db.execute(sql.raw(`
      CREATE POLICY tenant_isolation ON ${table}
        USING (account_id::text = current_setting('app.current_account_id', true))
    `));
  }

  // platform_user_accounts: user can see only their own rows
  await db.execute(sql.raw(`ALTER TABLE platform_user_accounts ENABLE ROW LEVEL SECURITY`));
  await db.execute(sql.raw(`DROP POLICY IF EXISTS self_access ON platform_user_accounts`));
  await db.execute(sql.raw(`
    CREATE POLICY self_access ON platform_user_accounts
      USING (platform_user_id::text = current_setting('app.current_user_id', true))
  `));

  console.log("[rls] Row-Level Security policies applied");
}

// ─── Per-request context setter ───────────────────────────────────────────────

/**
 * Sets the PostgreSQL session variables used by RLS policies.
 * Call this at the start of every request that touches tenant data.
 *
 * NOTE: We use a transaction-local setting (set_config with is_local=true)
 * so the value resets automatically when the transaction ends.
 */
export async function setAccountContext(
  accountId: string,
  platformUserId?: string
): Promise<void> {
  await db.execute(
    sql`SELECT
      set_config('app.current_account_id', ${accountId}, true),
      set_config('app.current_user_id',    ${platformUserId ?? ""}, true)`
  );
}

/**
 * Wraps a callback in a transaction with the RLS context set.
 * The context is automatically cleared when the transaction ends.
 */
export async function withAccountContext<T>(
  accountId: string,
  platformUserId: string,
  fn: () => Promise<T>
): Promise<T> {
  return db.transaction(async () => {
    await setAccountContext(accountId, platformUserId);
    return fn();
  });
}
