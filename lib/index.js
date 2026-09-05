import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * dsh-multi-model-orchestrator
 *
 * A DeepSeek Harness plugin that turns the primary AI into a multi-model
 * "main brain": when a task is complex it decomposes the task into subtasks
 * and dispatches each to the sub-agent model best suited for it, while
 * tracking per-(provider/model) token usage.
 *
 * Runtime capabilities (all self-contained, none rely on patching harness
 * internals):
 *   1. llm/stream waterfall accounting of token usage per provider/model.
 *   2. A system-prompt section coaching the main brain how to decompose and
 *      dispatch, using the user-supplied "model notes" (strengths / weaknesses)
 *      as the basis for assignment.
 *   3. A `model_token_usage` tool exposing the accumulated per-model usage.
 *
 * User-tunable inputs arrive declaratively through the plugin's own settings
 * namespace `multi-model-orchestrator` in $DSH_HOME/settings.yaml (see
 * examples/settings.yaml) — no cordis.patch needed to configure the plugin.
 */

const name = "multi-model-orchestrator";

/** Required services. `settings` is optional and resolved via nested inject. */
const inject = ["systemPrompt", "tools"];

/** Settings namespace carrying this plugin's user configuration. */
const NS = "multi-model-orchestrator";

/** One model note: a short rationale for dispatching work to a route. */
const ModelNote = z.object({
  description: z.string().default(""),
  strengths: z.string().default(""),
  weaknesses: z.string().default("")
});

/** Plugin-level config (also used as the base for the settings section). */
const Config = z.object({
  modelNotes: z.dict(ModelNote).default({})
});

/** Shape of the `multi-model-orchestrator:` section in settings.yaml. */
const SettingsSchema = z.object({
  modelNotes: z.dict(ModelNote).default({})
});

/** Render model notes as a "model cheat-sheet" paragraph, if any are given. */
function renderModelNotes(modelNotes) {
  const notes = modelNotes ?? {};
  const lines = [];
  for (const [route, note] of Object.entries(notes)) {
    const desc = note.description ? ` — ${note.description}` : "";
    const strengths = note.strengths ? `strengths: ${note.strengths}` : "";
    const weaknesses = note.weaknesses ? `weaknesses: ${note.weaknesses}` : "";
    const trail = [strengths, weaknesses].filter(Boolean).join("; ");
    lines.push(`- ${route}${desc}${trail ? ` (${trail})` : ""}`);
  }
  if (lines.length === 0) return "";
  return `\n### Model cheat-sheet\n${lines.join("\n")}\n`;
}

/**
 * Coaching text injected into every agent's system prompt. It deliberately
 * avoids hard-coding concrete model ids: the main brain is told to inspect the
 * currently available routes (list_subagent_models) and to rely on the
 * cheat-sheet above plus the provider/model names for assignment.
 */
function buildGuidance(modelNotes) {
  return `You are a multi-model "main brain" (orchestrator). When a task is complex, decompose it into parallel subtasks and dispatch each subtask to the sub-agent model best suited for it.

How to proceed:
1. Judge complexity first: a task is complex when it contains several independent sub-questions, needs different domain expertise, or does not fit in a single context window.
2. Use todo_write to record the subtasks you decompose.
3. Call list_subagent_models to see the currently available providers/models (call it with no arguments to list providers, or pass a provider to list its models).
4. For each subtask, pick the provider/model that best matches it, using the Model cheat-sheet below and each route's name as guidance.
5. Dispatch through the subagent tool: give a precise description and a self-contained prompt, and set provider/model to select the sub-agent's model.
6. Launch independent sub-agent delegations together in a single message (they run in the background by default) and keep working on results you do not depend on; only block on a child when the next step truly needs its result (run_in_background: false).
7. You will be notified when a background sub-agent finishes; gather the results and synthesize the final delivery.

Dispatch rules:
- Complex reasoning, complex coding, long-context work → a strong model (whatever the strongest available routes are).
- Simple, high-volume, speed- or cost-sensitive work → a fast/cheap model.
- Prefer running same-kind subtasks in parallel instead of serializing them.
- Sub-agents cannot see this conversation; every task description must be complete and self-contained.${renderModelNotes(modelNotes)}`;
}

function apply(ctx, config) {
  // ── Per (provider/model) token usage, accumulated for this process ──────
  const usageByRoute = new Map(); // key = `${provider}\0${model}`

  function recordUsage(provider, model, usage) {
    if (usage === void 0 || usage === null) return;
    const key = `${provider}\0${model}`;
    let entry = usageByRoute.get(key);
    if (entry === void 0) {
      entry = {
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0
      };
      usageByRoute.set(key, entry);
    }
    entry.inputTokens += usage.inputTokens ?? 0;
    entry.outputTokens += usage.outputTokens ?? 0;
    entry.cacheReadTokens += usage.cacheReadTokens ?? 0;
    entry.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    entry.requests += 1;
  }

  // llm/stream is the waterfall every model call passes through. Wrapping
  // next() lets us account usage chunks per provider/model. global: true so we
  // observe every model call (including sub-agents) regardless of realm.
  ctx.on("llm/stream", (options, next) => {
    const provider = options.provider;
    const model = options.model;
    return (async function* () {
      for await (const chunk of next()) {
        if (chunk.type === "usage" && chunk.usage !== void 0) {
          recordUsage(provider, model, chunk.usage);
        }
        yield chunk;
      }
    })();
  }, { global: true });

  // ── Read the user's model notes (settings section over composition) ──────
  // Without a settings service this degrades to the plugin config (or {}).
  // NB: the initial source returns the SAME shape ({ modelNotes }) as the
  // settings scope.get() below, so currentModelNotes() reads both uniformly.
  let source = () => ({ modelNotes: config.modelNotes ?? {} });
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, SettingsSchema, { modelNotes: config.modelNotes ?? {} }, {
      setSource: (read) => { source = read; },
      onChange: () => {}
    });
  });

  function currentModelNotes() {
    const value = source()?.modelNotes;
    return value && typeof value === "object" ? value : {};
  }

  // ── Orchestration guidance (global section, every agent) ────────────────
  // text is a function so the latest model notes are read at assembly time;
  // order 400 sits right before the plan policy block (500).
  ctx.systemPrompt.section({
    name: "multi-model-orchestration",
    order: 400,
    text: () => buildGuidance(currentModelNotes())
  });

  // ── Per-model token usage tool ────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "model_token_usage",
    description: "Report token usage per model (provider/model): input, output, cache read/write tokens and request counts, sorted by total usage descending. Gives the multi-model collaboration its cost and usage distribution. Accumulated since this process started.",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, result) => [{ type: "text", text: result }]
    },
    isConcurrencySafe: () => true,
    execute() {
      const rows = [...usageByRoute.values()].sort(
        (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
      );
      if (rows.length === 0) {
        return "No records yet: no model call has returned usage since this plugin loaded.";
      }
      const lines = ["Per-model token usage (accumulated since this process started):", ""];
      for (const r of rows) {
        const total = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
        lines.push(`- ${r.provider}/${r.model}: input ${r.inputTokens}, output ${r.outputTokens}, cache read ${r.cacheReadTokens}, cache write ${r.cacheWriteTokens}, total ${total}, ${r.requests} request(s)`);
      }
      return lines.join("\n");
    }
  }));
}

export { Config, apply, inject, name };
