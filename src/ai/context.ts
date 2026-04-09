/**
 * Builds the runtime system prompt for the AI assistant.
 * Injects account-specific context: pipelines, stage names, manager names, current date.
 */
import { db } from "../lib/db/index.js";
import { users, pipelines, pipelineStages, accounts } from "../lib/db/schema.js";
import { eq, and } from "drizzle-orm";

export type AssistantContext = {
  accountId: string;
  // Lookup maps for resolving names → IDs
  managersByName: Map<string, number>;
  managersById: Map<number, string>;
  pipelinesByName: Map<string, number>;
  pipelinesById: Map<number, string>;
  stagesById: Map<number, string>;
  stagesByPipeline: Map<number, { id: number; name: string; sort: number }[]>;
  timezone: string;
  planTargets: Record<string, number>; // user_amo_id → monthly revenue target
};

export async function buildAssistantContext(accountId: string): Promise<AssistantContext> {
  const [accountRows, managerRows, pipelineRows, stageRows] = await Promise.all([
    db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
      columns: { settings: true },
    }),
    db.select().from(users).where(and(eq(users.accountId, accountId), eq(users.isActive, true))),
    db.select().from(pipelines).where(eq(pipelines.accountId, accountId)),
    db.select().from(pipelineStages).where(eq(pipelineStages.accountId, accountId)),
  ]);

  const settings = accountRows?.settings ?? {};
  const timezone: string = (settings as Record<string, unknown>).timezone as string ?? "UTC";
  const planTargets: Record<string, number> =
    (settings as Record<string, unknown>).planTargets as Record<string, number> ?? {};

  const managersByName = new Map<string, number>();
  const managersById = new Map<number, string>();
  for (const m of managerRows) {
    const nameKey = m.name.toLowerCase();
    managersByName.set(nameKey, m.amoId);
    managersById.set(m.amoId, m.name);
    // Also index by first name for convenience
    const firstName = m.name.split(" ")[0].toLowerCase();
    if (!managersByName.has(firstName)) {
      managersByName.set(firstName, m.amoId);
    }
  }

  const pipelinesByName = new Map<string, number>();
  const pipelinesById = new Map<number, string>();
  for (const p of pipelineRows) {
    pipelinesByName.set(p.name.toLowerCase(), p.amoId);
    pipelinesById.set(p.amoId, p.name);
  }

  const stagesById = new Map<number, string>();
  const stagesByPipeline = new Map<number, { id: number; name: string; sort: number }[]>();
  for (const s of stageRows) {
    stagesById.set(s.amoId, s.name);
    if (!stagesByPipeline.has(s.pipelineId)) {
      stagesByPipeline.set(s.pipelineId, []);
    }
    stagesByPipeline.get(s.pipelineId)!.push({ id: s.amoId, name: s.name, sort: s.sort });
  }

  // Sort stages by sort order within each pipeline
  for (const [, stages] of stagesByPipeline) {
    stages.sort((a, b) => a.sort - b.sort);
  }

  return {
    accountId,
    managersByName,
    managersById,
    pipelinesByName,
    pipelinesById,
    stagesById,
    stagesByPipeline,
    timezone,
    planTargets,
  };
}

export function buildSystemPrompt(ctx: AssistantContext): string {
  const today = new Date().toLocaleDateString("ru-RU", {
    timeZone: ctx.timezone,
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const managerList = Array.from(ctx.managersById.entries())
    .map(([id, name]) => `  - ${name} (ID: ${id})`)
    .join("\n");

  const pipelineList = Array.from(ctx.pipelinesById.entries())
    .map(([id, name]) => {
      const stages = ctx.stagesByPipeline.get(id) ?? [];
      const stageStr = stages.map((s) => s.name).join(" → ");
      return `  - ${name} (ID: ${id}): ${stageStr}`;
    })
    .join("\n");

  return `You are an expert sales analytics assistant for an AmoCRM-based sales department.
Today's date: ${today} (timezone: ${ctx.timezone}).

You have access to tools that query real data. ALWAYS use tools to answer questions with numbers.
Never make up or estimate numerical data — only report what the tools return.

## Managers in this account
${managerList || "  (no active managers)"}

## Pipelines and stages
${pipelineList || "  (no pipelines)"}

## How to resolve names
When a user mentions a manager by name (full or partial), match it to the list above and pass the exact name to the tool — the system will resolve it.
If a name is ambiguous, ask the user to clarify.

## Response style
- Be concise and factual.
- Format numbers clearly (currency in ₽, percentages with %, days with д.).
- When presenting multiple managers, use a short table or ranked list.
- If you don't have enough data to answer, say so rather than guessing.
- Answer in the same language the user writes in.`;
}
