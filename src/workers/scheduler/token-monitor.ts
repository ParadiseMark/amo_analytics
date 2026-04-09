/**
 * Token expiry monitor.
 * Runs daily and alerts for accounts whose AmoCRM refresh token
 * will expire within 14 days (AmoCRM refresh tokens live ~3 months).
 *
 * On expiry:
 *  - Sets account.needsReauth = true
 *  - Logs a warning (in production: send email / Telegram alert)
 *
 * AmoCRM refresh tokens are valid for 60 days from last use.
 * We alert at 14 days remaining to give time to re-auth.
 */
import { db } from "../../lib/db/index.js";
import { accounts } from "../../lib/db/schema.js";
import { lt, and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

const ALERT_DAYS_BEFORE = 14;

export async function runTokenExpiryMonitor(): Promise<void> {
  const threshold = new Date(Date.now() + ALERT_DAYS_BEFORE * 24 * 3600 * 1000);

  // Find accounts where token expires within ALERT_DAYS_BEFORE days
  const expiring = await db
    .select({
      id: accounts.id,
      subdomain: accounts.subdomain,
      tokenExpiresAt: accounts.tokenExpiresAt,
      needsReauth: accounts.needsReauth,
    })
    .from(accounts)
    .where(
      and(
        lt(accounts.tokenExpiresAt, threshold),
        eq(accounts.needsReauth, false),
        eq(accounts.syncStatus, "ready")
      )
    );

  if (expiring.length === 0) {
    console.log("[token-monitor] All tokens healthy");
    return;
  }

  for (const account of expiring) {
    const daysLeft = Math.round(
      (account.tokenExpiresAt.getTime() - Date.now()) / (24 * 3600 * 1000)
    );

    if (daysLeft <= 0) {
      // Already expired — mark for re-auth
      await db
        .update(accounts)
        .set({ needsReauth: true, syncStatus: "error", updatedAt: new Date() })
        .where(eq(accounts.id, account.id));

      console.error(
        `[token-monitor] EXPIRED account=${account.subdomain} — sync paused, re-auth required`
      );
    } else {
      console.warn(
        `[token-monitor] WARNING account=${account.subdomain} token expires in ${daysLeft} days`
      );
      // TODO: send email / Telegram alert via notification service
    }
  }

  console.log(`[token-monitor] Checked ${expiring.length} expiring accounts`);
}
