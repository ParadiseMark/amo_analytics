/**
 * Token encryption/decryption with per-account HKDF-derived keys.
 *
 * Each account gets a unique 256-bit key derived via HKDF:
 *   key = HKDF-SHA256(master_secret, salt="amo-token", info=account_id)
 *
 * This means:
 *   - Compromising one account's key doesn't affect others
 *   - The master secret never touches the DB; only ciphertext is stored
 *   - Existing tokens encrypted with the old shared key are re-encrypted
 *     on first read via a transparent migration path
 */
import { createHmac, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../lib/db/index.js";
import { accounts } from "../../lib/db/schema.js";
import { env } from "../../config/env.js";

const ALGORITHM = "aes-256-gcm";

// Master secret as Buffer — derived from TOKEN_ENCRYPTION_KEY
const MASTER = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");

// ─── Per-account key derivation ───────────────────────────────────────────────

/**
 * Derives a 32-byte AES key unique to this account using HKDF-SHA256.
 * Deterministic: same master + accountId always gives the same key.
 */
function deriveKey(accountId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      MASTER,
      Buffer.alloc(32, 0), // fixed salt (no per-call randomness needed — accountId is the differentiator)
      Buffer.from(`amo-token:${accountId}`, "utf8"),
      32
    )
  );
}

// ─── Encryption / decryption ──────────────────────────────────────────────────

/**
 * Encrypts plaintext with a key derived for the given account.
 * Format: "v2:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * The "v2:" prefix distinguishes from old shared-key format.
 */
export function encrypt(plaintext: string, accountId: string): string {
  const key = deriveKey(accountId);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v2:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts ciphertext.
 * Handles both v2 (HKDF per-account) and legacy v1 (shared key) transparently.
 */
export function decrypt(ciphertext: string, accountId: string): string {
  if (ciphertext.startsWith("v2:")) {
    return decryptV2(ciphertext.slice(3), accountId);
  }
  // Legacy v1: shared key, format "iv:authTag:ciphertext"
  return decryptV1(ciphertext);
}

function decryptV2(payload: string, accountId: string): string {
  const [ivHex, authTagHex, encryptedHex] = payload.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) throw new Error("Invalid v2 ciphertext");
  const key = deriveKey(accountId);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return (
    decipher.update(Buffer.from(encryptedHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

function decryptV1(ciphertext: string): string {
  // Old shared-key path — only used for migration on first read
  const LEGACY_KEY = MASTER.slice(0, 32); // first 32 bytes as legacy key
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) throw new Error("Invalid v1 ciphertext");
  const decipher = createDecipheriv(ALGORITHM, LEGACY_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return (
    decipher.update(Buffer.from(encryptedHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

// ─── Token storage ────────────────────────────────────────────────────────────

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export async function getTokens(accountId: string): Promise<StoredTokens> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
    columns: {
      accessToken: true,
      refreshToken: true,
      tokenExpiresAt: true,
    },
  });
  if (!account) throw new Error(`Account ${accountId} not found`);

  const accessToken  = decrypt(account.accessToken, accountId);
  const refreshToken = decrypt(account.refreshToken, accountId);

  // Transparent migration: if stored in legacy v1 format, re-encrypt with v2
  if (!account.accessToken.startsWith("v2:")) {
    await db
      .update(accounts)
      .set({
        accessToken:  encrypt(accessToken, accountId),
        refreshToken: encrypt(refreshToken, accountId),
        updatedAt:    new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  return { accessToken, refreshToken, expiresAt: account.tokenExpiresAt };
}

export async function saveTokens(
  accountId: string,
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number
): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  await db
    .update(accounts)
    .set({
      accessToken:  encrypt(accessToken, accountId),
      refreshToken: encrypt(refreshToken, accountId),
      tokenExpiresAt: expiresAt,
      needsReauth: false,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));
}

export async function markNeedsReauth(accountId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ needsReauth: true, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
}

export function isTokenExpiringSoon(expiresAt: Date, bufferSeconds = 300): boolean {
  return Date.now() + bufferSeconds * 1000 >= expiresAt.getTime();
}
