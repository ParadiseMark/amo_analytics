/**
 * AI assistant chat route.
 *
 * POST /api/v1/ai/:accountId/chat
 *   Body: { message: string, history?: Message[] }
 *   Returns: SSE stream of text chunks, ending with [DONE]
 *
 * Uses Server-Sent Events so the frontend can render text as it arrives.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { db } from "../../lib/db/index.js";
import { platformUserAccounts } from "../../lib/db/schema.js";
import { and, eq } from "drizzle-orm";
import { runAssistant, type Message } from "../../ai/assistant.service.js";
import { setAccountContext } from "../../lib/db/rls.js";

const chatBodySchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    )
    .max(20)
    .default([]),
});

async function verifyAccountAccess(
  req: FastifyRequest<{ Params: { accountId: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const userId: string = (req.user as { sub: string }).sub;
  const { accountId } = req.params;

  const access = await db.query.platformUserAccounts.findFirst({
    where: and(
      eq(platformUserAccounts.platformUserId, userId),
      eq(platformUserAccounts.accountId, accountId)
    ),
  });

  if (!access) {
    return reply.code(403).send({ error: "Forbidden" });
  }

  await setAccountContext(accountId, userId);
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", verifyAccountAccess);

  app.post("/:accountId/chat", async (req, reply) => {
    const { accountId } = req.params as { accountId: string };

    const parseResult = chatBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: "Invalid request body", issues: parseResult.error.issues });
    }

    const { message, history } = parseResult.data;

    const conversationHistory: Message[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: message },
    ];

    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    reply.raw.flushHeaders();

    const sendEvent = (data: string) => {
      reply.raw.write(`data: ${JSON.stringify({ chunk: data })}\n\n`);
    };

    try {
      for await (const chunk of runAssistant(accountId, conversationHistory)) {
        sendEvent(chunk);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    }
  });
}
