# Plan — v1.15.0 Pipeline Decoupling + ModelRouter

Three coordinated tasks. Incorporates your corrections: orchestrator must be rewired, ModelRouter must cover `memory.functions.ts` + `session.functions.ts`, and Finance Guard stays as prompt injection (no separate LLM call).

---

## Task 1 — Decouple Planner from Synthesiser

**`src/lib/voice/pipeline/llm.functions.ts`**
- Split `generateAIResponse` into two exported server fns:
  - `planQueries({ userText, history, systemInstruction })` → returns a structured `QueryPlan`: `{ toolCalls: Array<{name, args}>, analytical: boolean, rationale: string }`. Uses the LLM in **single-pass tool-declaration mode** (no execution), forced via a "PLANNER ROLE" system instruction override. For analytical queries the planner must emit ≥3 parallel tool calls.
  - `synthesizeAnswer({ userText, history, systemInstruction, toolResults })` → no tools exposed; receives pre-fetched tool results as a structured `[TOOL RESULTS]` block in the prompt. Runs the existing critic refinement loop here.
- Keep `runTool`, `refineQuery`, `evaluateDraft`, `sleep`, `aggregateToolData`, sports/finance guards intact — they're now called by the orchestrator (for tool execution) and `synthesizeAnswer` (for critic).
- Preserve `generateAIResponse` as a thin back-compat wrapper that calls plan → execute → synthesise sequentially, so any other caller doesn't break.

**`src/lib/voice/pipeline/orchestrator.ts`**
- Extend `TurnDeps` with `plan` and `synthesize` (rename existing `synthesize` for TTS to `synthesizeSpeech` to avoid the name collision — update all call sites).
- New `runTurn` flow after STT:
  1. `cbs.onThinking()` → `deps.plan(...)` to get `QueryPlan`.
  2. Execute each `toolCall` directly via `runTool` (exported from llm.functions). Run in parallel with `Promise.all`. Emit `cbs.onToolCall` per result.
  3. `deps.synthesizeAnswer({ ..., toolResults })` → final text + history.
  4. Existing sentence-chunked TTS path unchanged.
- Wire the new deps in the caller of `runTurn` (search for `runTurn(` to find injection site, likely `VoiceCompanion.tsx`).

---

## Task 2 — ModelRouter (eliminate hard-coded model strings)

**New file `src/lib/voice/modelRouter.ts`**
- Server-only helper extending `readProvidersServerSide()`.
- Exports:
  - `resolveLlmModel()` → `{ provider, model, apiUrl, apiKey, label }` for the currently selected provider (gemini / qwen / grok). Centralises every model id (`gemini-2.5-flash`, `qwen-plus`, `grok-4-latest`).
  - `resolveCriticModel()` → returns the same provider as main LLM when possible (so the critic respects user choice); falls back to Gemini Flash only if the selected provider lacks an API key.
  - `resolveUtilityModel()` → for non-conversational helpers (translation, summarisation). Routes through **Lovable AI Gateway** with `google/gemini-2.5-flash` as default. Exposes `callUtilityChat({ system, user, maxTokens })`.

**`src/lib/voice/pipeline/llm.functions.ts`**
- Replace the hardcoded Gemini call inside `evaluateDraft()` with `resolveCriticModel()` + a generic chat helper.
- Replace hardcoded model strings in `runGemini` / `runQwen` / `runGrok` with `resolveLlmModel()` values (keep the three runner shapes; they read model/url/key from the router).

**`src/lib/voice/memory.functions.ts`**
- Replace `model: "google/gemini-3-flash-preview"` (invalid id — model doesn't exist) with `resolveUtilityModel()` / `callUtilityChat`. Default lands on `google/gemini-2.5-flash`.

**`src/lib/voice/session.functions.ts`**
- Replace the hardcoded `model: "google/gemini-2.5-flash"` in `translateToTraditionalChinese()` with `callUtilityChat()` from the router.

---

## Task 3 — Critic + Finance Guard confirmation

- **Critic**: now provider-agnostic via `resolveCriticModel()` (Task 2 covers it). Critic still runs only after `synthesizeAnswer` produces a draft; refinement loop stays at max 2 passes.
- **Finance Guard**: no change beyond Task 2. The dual-source Yahoo+Google fetch in `runTool` is plain code (no LLM); the `[FINANCE GUARD]` block is consumed by whatever main LLM the ModelRouter selects, so it becomes model-agnostic automatically.
- Add a one-line comment in `runTool` documenting that Finance Guard is prompt-injection only, so future readers don't try to "fix" it.

---

## Version + verification

- Bump `src/lib/version.ts` → `1.15.0`.
- After build: smoke-test in preview with (a) a sports query (planner must emit `web_search`), (b) `1357.HK 股價` (Finance Guard injection still appears), (c) provider toggle to Qwen on `/instruction` (critic + main both switch).

## Out of scope

- No changes to TTS pipeline, recorder, system prompt text, edge functions, or DB schema.
- No new tables, no new env vars.
