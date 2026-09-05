# dsh-multi-model-orchestrator

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that turns your primary AI into a **multi-model "main brain"**. When a task is complex, it decomposes the task into subtasks and dispatches each to the sub-agent model best suited for it (GLM / Kimi / Qwen / any OpenAI-compatible route you configure), while tracking **per-model token usage**.

## Features

1. **Multi-model orchestration guidance** — a system-prompt section coaches the main brain to decompose complex tasks, inspect available routes with `list_subagent_models`, and dispatch each subtask via `subagent` with an explicit `provider` / `model`.
2. **Model-aware dispatch** — you describe each route's strengths/weaknesses once (see config); the main brain assigns work accordingly (strong models for hard reasoning, fast/cheap ones for high-volume work).
3. **Per-model token usage** — a `model_token_usage` tool reports input / output / cache read / cache write tokens and request counts per `provider/model`, accumulated since the process started.

The plugin does **not** touch any harness internals. All model routes and the sub-agent allow-list are ordinary harness settings — see [examples/settings.yaml](examples/settings.yaml).

## Install

Install into a dsh profile (usually `web`):

```sh
dsh plugin --profile web add dsh-multi-model-orchestrator
```

or, from a git checkout:

```sh
dsh plugin --profile web add github:YOU/dsh-multi-model-orchestrator
```

Restart the harness (or reload the profile) afterwards. The plugin loads itself as a profile layer via its `cordis.patch.yml`.

## Quick start

1. **Add your third-party model routes** to `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`). GLM / Kimi / Qwen presets ready to paste: see [examples/settings.yaml](examples/settings.yaml). Each route needs only an API key behind `apiKeyEnv` (env var, `$DSH_HOME/.credentials.yaml`, or the web **Models** page).

2. **Enable sub-agent model selection** so the main brain can pick the model for each child:
   ```yaml
   subagent-model-selection:
     enabled: true
     allowedModels:
       - { provider: glm, model: glm-4.6 }
       # ... your other routes
   ```

3. **(Optional) Add model notes** the main brain reads when assigning work:
   ```yaml
   multi-model-orchestrator:
     modelNotes:
       glm/glm-4.6:
         description: Zhipu flagship, strong reasoning.
         strengths: complex reasoning, coding, agentic tool use
         weaknesses: slower and pricier
   ```

4. Restart the harness and ask, e.g.:
   > Break this into parallel subtasks and dispatch each to the best model.

### Credentials

Keys are resolved per request through each route's `apiKeyEnv`. Provide them any of these ways:

- **Environment variables**: `GLM_API_KEY` / `KIMI_API_KEY` / `DASHSCOPE_API_KEY` (per your route names).
- **Credential store** `$DSH_HOME/.credentials.yaml`:
  ```yaml
  GLM_API_KEY: sk-xxxx
  KIMI_API_KEY: sk-xxxx
  DASHSCOPE_API_KEY: sk-xxxx
  ```
- **Web "Models" page**: paste the key directly (stored in the managed credential document).

Routes without a key fail at request time with `MISSING_CREDENTIAL` and do not affect configured ones.

## How the main brain works

Ask for a complex task in the main conversation. The main brain will:

1. use `todo_write` to record the decomposed subtasks;
2. call `list_subagent_models` to see available routes;
3. dispatch each subtask through `subagent` (with `provider` / `model`) to the best-fit model — launching independent delegations in one message, running them in the background by default;
4. gather results and synthesize the final deliverable.

To see usage, ask the main brain to call `model_token_usage` (or just ask "how many tokens has each model used?").

## Configuration reference

Everything is configured in `$DSH_HOME/settings.yaml`:

| Section | Purpose |
|---|---|
| `llm-pi-ai.providers` | OpenAI-compatible third-party model routes (any vendor). |
| `subagent-model-selection` | Allow-list of `{provider, model}` the sub-agent tool may dispatch to. |
| `multi-model-orchestrator.modelNotes` | Per-route strengths/weaknesses that guide assignment. |

To add your own vendor, extend `llm-pi-ai.providers` with `{ api, baseURL, apiKeyEnv, models }` (any OpenAI-compatible `api: openai-completions` gateway works), then add matching entries to `subagent-model-selection.allowedModels` and `multi-model-orchestrator.modelNotes`.

## Notes & limitations

- Token usage is **per-process** (cleared when the harness restarts); per-session usage still shows in the built-in token meter.
- `model_token_usage` needs at least one model call that returned a `usage` chunk before it reports anything.
- The orchestration guidance is injected globally, so sub-agents read it too; its wording keeps sub-agents from recursively re-decomposing their single focused subtask.
- Third-party routes are registered as **non-reasoning** models by default; reasoning flags (`reasoningEfforts` / `compat.thinkingFormat`) can be added per model on the web **Models** page.

## Troubleshooting

- **`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/...'`** — the plugin was linked manually (raw `link:` + a hand-made `node_modules` junction) instead of installed through `dsh plugin ... add`. Install it as a real dependency of the profile and remove the junction.
- **`model_token_usage` returns "No records yet"** — no model call has completed with usage since load; make a request and ask again.
- **Children cannot be dispatched to a route / `list_subagent_models` is empty** — check that `subagent-model-selection` is `enabled: true` with a non-empty `allowedModels`, and that the routes exist under `llm-pi-ai.providers`.

## License

MIT
