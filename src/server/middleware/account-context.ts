/**
 * Fastify preHandler middleware that sets the PostgreSQL RLS context.
 * Must run after JWT verification.
 *
 * Sets:
 *   app.current_account_id  → accountId from route params
 *   app.current_user_id     → platformUserId from JWT
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { setAccountContext } from "../../lib/db/rls.js";

export async function applyAccountContext(
  req: FastifyRequest<{ Params: { accountId?: string } }>,
  _reply: FastifyReply
): Promise<void> {
  const accountId = req.params?.accountId;
  if (!accountId) return;

  const platformUserId = (req.user as { sub?: string } | undefined)?.sub ?? "";

  // Set PostgreSQL session variables — scoped to this request's connection
  // (setAccountContext uses set_config with is_local=false here because
  //  connection-pool connections aren't in a transaction at this point;
  //  the actual queries will run with this setting active)
  await setAccountContext(accountId, platformUserId);
}
