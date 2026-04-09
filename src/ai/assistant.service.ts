/**
 * AI assistant service.
 * Orchestrates GPT-4o with function calling (→ ClickHouse analytics)
 * and a fallback to pgvector semantic search (→ PostgreSQL notes).
 *
 * Supports streaming via an async generator that yields text chunks.
 */
import OpenAI from "openai";
import { env } from "../config/env.js";
import { tools } from "./tools.js";
import { buildAssistantContext, buildSystemPrompt } from "./context.js";
import { handleToolCall } from "./tool-handlers.js";
import { redisCache } from "../lib/redis/index.js";
import { createHash } from "crypto";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL = 60 * 10; // 10 minutes

function cacheKey(accountId: string, messages: Message[]): string {
  const hash = createHash("sha256")
    .update(accountId + JSON.stringify(messages.slice(-3)))
    .digest("hex")
    .substring(0, 16);
  return `ai:cache:${accountId}:${hash}`;
}

// ─── Main streaming entry point ───────────────────────────────────────────────

/**
 * Run the AI assistant for a given conversation.
 * Yields text chunks as they arrive from the model.
 * Handles tool calls automatically (up to 5 rounds).
 */
export async function* runAssistant(
  accountId: string,
  conversationHistory: Message[]
): AsyncGenerator<string> {
  // Build context (pipelines, managers, etc.)
  const ctx = await buildAssistantContext(accountId);
  const systemPrompt = buildSystemPrompt(ctx);

  // Check cache for the last user message
  const ck = cacheKey(accountId, conversationHistory);
  const cached = await redisCache.get(ck);
  if (cached) {
    yield cached;
    return;
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
  ];

  let fullResponse = "";
  let iterations = 0;
  const MAX_TOOL_ROUNDS = 5;

  // Agentic loop: call model → handle tool calls → repeat until done
  while (iterations < MAX_TOOL_ROUNDS) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
      temperature: 0.2,
      max_tokens: 2000,
    });

    // Collect streamed response
    let currentText = "";
    const toolCallAccumulators: Map<number, {
      id: string;
      name: string;
      arguments: string;
    }> = new Map();

    let finishReason: string | null = null;

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

      if (delta?.content) {
        currentText += delta.content;
        fullResponse += delta.content;
        yield delta.content;
      }

      // Accumulate tool call deltas
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulators.has(tc.index)) {
            toolCallAccumulators.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            });
          }
          const acc = toolCallAccumulators.get(tc.index)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
    }

    // If the model produced text without tool calls, we're done
    if (toolCallAccumulators.size === 0) {
      break;
    }

    // Execute all tool calls in parallel
    const toolCalls = Array.from(toolCallAccumulators.values());

    const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam = {
      role: "assistant",
      content: currentText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMessage);

    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          // invalid JSON from model
        }
        const result = await handleToolCall(tc.name, args, ctx);
        return { tool_call_id: tc.id, content: result };
      })
    );

    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: result.content,
      });
    }

    // Continue to next iteration so model can use the tool results
  }

  // Cache successful responses
  if (fullResponse) {
    await redisCache.setex(ck, CACHE_TTL, fullResponse);
  }
}

// ─── Non-streaming version (for Telegram bot) ─────────────────────────────────

export async function runAssistantSync(
  accountId: string,
  conversationHistory: Message[]
): Promise<string> {
  let result = "";
  for await (const chunk of runAssistant(accountId, conversationHistory)) {
    result += chunk;
  }
  return result;
}
