/**
 * Bull Board — BullMQ queue monitoring UI.
 * Mounted at /admin/queues (basic auth protected in production).
 */
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue } from "bullmq";
import { redis } from "../lib/redis/index.js";
import { db } from "../lib/db/index.js";
import { accounts } from "../lib/db/schema.js";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function registerBullBoard(app: FastifyInstance): Promise<void> {
  const serverAdapter = new FastifyAdapter();

  // Always add the global queues
  const globalQueues = ["embeddings"].map(
    (name) => new BullMQAdapter(new Queue(name, { connection: redis }))
  );

  // Add per-account queues for all known accounts
  const activeAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.syncStatus, "ready"));

  const accountQueues = activeAccounts.flatMap((a) =>
    [`sync-${a.id}`, `metrics-${a.id}`, `analytics-${a.id}`].map(
      (name) => new BullMQAdapter(new Queue(name, { connection: redis }))
    )
  );

  createBullBoard({
    queues: [...globalQueues, ...accountQueues] as any,
    serverAdapter,
  });

  serverAdapter.setBasePath("/admin/queues");

  // Basic auth protection
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/admin/queues")) return;

    const adminToken = process.env.BULL_BOARD_TOKEN;
    if (!adminToken) return; // No token set → open (dev mode)

    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== adminToken) {
      reply.header("WWW-Authenticate", 'Bearer realm="Bull Board"');
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await app.register(serverAdapter.registerPlugin() as any, { prefix: "/admin/queues", logLevel: "warn" });

  console.log("[bull-board] Registered at /admin/queues");
}
