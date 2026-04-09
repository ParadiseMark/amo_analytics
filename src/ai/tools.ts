/**
 * OpenAI function-calling tool definitions for the AI assistant.
 * The model chooses which tool to call based on the user's question.
 */
import type OpenAI from "openai";

export const tools: OpenAI.Chat.ChatCompletionTool[] = [
  // ── Metrics & KPIs ─────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_manager_kpis",
      description:
        "Get aggregated KPI metrics for one or all managers over a period. " +
        "Use for questions like 'How much did Ivanov sell?', 'Call activity this week', 'Win rate last month'.",
      parameters: {
        type: "object",
        properties: {
          manager_name: {
            type: "string",
            description: "Manager name or 'all' for the whole team. The system will resolve to user_amo_id.",
          },
          period: {
            type: "string",
            enum: ["7d", "30d", "90d"],
            description: "Time period. Default: 30d.",
          },
          metrics: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "revenue_won", "deals_won", "deals_lost", "win_rate",
                "calls_made", "calls_answered", "avg_call_duration",
                "tasks_completed", "tasks_overdue", "notes_added",
                "response_time_p50", "deal_velocity_avg", "avg_deal_value",
              ],
            },
            description: "Specific metrics to include. Omit for all.",
          },
        },
        required: ["manager_name"],
      },
    },
  },

  // ── Plan vs actual ─────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_manager_vs_plan",
      description:
        "Get a manager's revenue vs plan gap. Use for 'How much until plan?', 'Plan completion %'.",
      parameters: {
        type: "object",
        properties: {
          manager_name: { type: "string", description: "Manager name." },
          period: { type: "string", enum: ["7d", "30d", "90d"], description: "Period. Default: 30d." },
        },
        required: ["manager_name"],
      },
    },
  },

  // ── Manager profile ────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_manager_profile",
      description:
        "Get a manager's strength/weakness profile and percentile rankings. " +
        "Use for 'What is Petrov's weak area?', 'Who is the best responder?'.",
      parameters: {
        type: "object",
        properties: {
          manager_name: { type: "string" },
        },
        required: ["manager_name"],
      },
    },
  },

  // ── Stuck deals ────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_stuck_deals",
      description:
        "Get deals with no activity for a long time. Use for 'What deals are stuck?', 'Show Kuznetsov's stale deals'.",
      parameters: {
        type: "object",
        properties: {
          manager_name: { type: "string", description: "Filter to one manager. Omit for all." },
          limit: { type: "number", description: "Max deals to return. Default 20." },
        },
        required: [],
      },
    },
  },

  // ── Recommendations ────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_recommendations",
      description:
        "Generate personalised recommendations for a manager based on their profile and KPIs. " +
        "Use for 'What should Smirnov focus on?', 'Give me tips for Ivanov'.",
      parameters: {
        type: "object",
        properties: {
          manager_name: { type: "string" },
        },
        required: ["manager_name"],
      },
    },
  },

  // ── Team ranking ───────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "list_managers_ranked",
      description:
        "Get a ranked leaderboard of managers by a given metric. " +
        "Use for 'Top managers by revenue', 'Who called the most this week?'.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["7d", "30d", "90d"] },
          metric: {
            type: "string",
            enum: ["revenue_won", "win_rate", "calls_made", "deals_won", "response_time_p50"],
          },
          limit: { type: "number", description: "Number of managers. Default 10." },
        },
        required: ["metric"],
      },
    },
  },

  // ── Pipeline funnel ────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_pipeline_funnel",
      description:
        "Get stage-by-stage conversion and time data for a pipeline. " +
        "Use for 'Show me the funnel', 'Where are deals dropping off?'.",
      parameters: {
        type: "object",
        properties: {
          pipeline_name: { type: "string", description: "Pipeline name — resolved to pipeline_amo_id." },
          period: { type: "string", enum: ["7d", "30d", "90d"] },
          manager_name: { type: "string", description: "Filter to one manager. Optional." },
        },
        required: ["pipeline_name"],
      },
    },
  },

  // ── Bottleneck stages ──────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_bottleneck_stages",
      description:
        "Get stages where deals spend too long on average. Use for 'Where is the bottleneck?', 'What stage is slow?'.",
      parameters: {
        type: "object",
        properties: {
          pipeline_name: { type: "string" },
        },
        required: [],
      },
    },
  },

  // ── Manager comparison ─────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "compare_managers",
      description:
        "Compare two or more managers side by side on given metrics. " +
        "Use for 'Compare Ivanov and Petrov', 'Who performs better — Smirnov or Kuznetsov?'.",
      parameters: {
        type: "object",
        properties: {
          manager_names: {
            type: "array",
            items: { type: "string" },
            description: "2+ manager names.",
          },
          period: { type: "string", enum: ["7d", "30d", "90d"] },
          metrics: {
            type: "array",
            items: { type: "string" },
            description: "Metrics to compare. Omit for all.",
          },
        },
        required: ["manager_names"],
      },
    },
  },

  // ── Semantic deal search (RAG) ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "search_deals_semantic",
      description:
        "Semantic search across deal notes, comments, and descriptions using AI embeddings. " +
        "Use for 'Find deals about construction', 'Search notes mentioning contract problems'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query." },
          manager_name: { type: "string", description: "Limit to a specific manager. Optional." },
          limit: { type: "number", description: "Max results. Default 10." },
        },
        required: ["query"],
      },
    },
  },

  // ── Deal details ───────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_deal_details",
      description:
        "Get full details of a specific deal including contacts, notes, calls, tasks. " +
        "Use when the user asks about a specific deal by name or ID.",
      parameters: {
        type: "object",
        properties: {
          deal_name: { type: "string", description: "Deal name (partial match allowed)." },
          deal_amo_id: { type: "number", description: "Exact deal ID if known." },
        },
        required: [],
      },
    },
  },
];
