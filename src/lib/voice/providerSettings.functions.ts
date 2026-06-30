// Provider selection (LLM brain + TTS mouth). Stored in app_settings so the
// user can change it from /instruction without redeploying.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type LlmProvider = "gemini" | "qwen" | "grok" | "openrouter";
export type TtsProvider = "google" | "minimax";

const LLM_KEY = "voice.llmProvider";
const TTS_KEY = "voice.ttsProvider";
const OPENROUTER_MODEL_KEY = "voice.openrouterModel";
const OPENROUTER_SYNTH_MODEL_KEY = "voice.openrouterSynthModel";
const GREETING_MODEL_KEY = "voice.greetingModel";
export const GROK_PLANNER_MODEL_KEY = "voice.grokPlannerModel";
export const GROK_SYNTH_MODEL_KEY = "voice.grokSynthModel";

export const DEFAULT_GROK_PLANNER_MODEL = "grok-4-latest";
export const DEFAULT_GROK_SYNTH_MODEL = "grok-3-mini";

/** Models suitable for the planner role (tool selection, JSON output). */
export const GROK_PLANNER_MODELS: { value: string; label: string }[] = [
  { value: "grok-4-latest", label: "Grok 4 Latest (recommended — best tool reasoning)" },
  { value: "grok-3-latest", label: "Grok 3 Latest (balanced)" },
  { value: "grok-3-mini", label: "Grok 3 Mini (fast — less reasoning)" },
];

/** Models suitable for synthesis and critic (fast prose, no deep reasoning). */
export const GROK_SYNTH_MODELS: { value: string; label: string }[] = [
  { value: "grok-3-mini", label: "Grok 3 Mini (recommended — fast, non-reasoning)" },
  { value: "grok-3-latest", label: "Grok 3 Latest (balanced)" },
  { value: "grok-2-latest", label: "Grok 2 Latest (stable)" },
];

export const LLM_PROVIDERS: { value: LlmProvider; label: string; note: string }[] = [
  { value: "gemini", label: "Google Gemini 2.5 Flash", note: "Default. Strong Cantonese + tool use." },
  { value: "qwen", label: "Alibaba Qwen (DashScope direct)", note: "Direct DashScope. Needs DASHSCOPE_API_KEY." },
  { value: "grok", label: "xAI Grok (direct)", note: "Direct xAI. Needs XAI_API_KEY." },
  { value: "openrouter", label: "OpenRouter (multi-model)", note: "Routes via OpenRouter — pick a model below. Needs OPENROUTER_API_KEY." },
];

export const TTS_PROVIDERS: { value: TtsProvider; label: string; note: string; available: boolean }[] = [
  { value: "google", label: "Google Gemini TTS", note: "Cantonese voices.", available: true },
  { value: "minimax", label: "MiniMax speech-02-hd", note: "Cantonese (Yue) boosted. Voice via MINIMAX_VOICE_ID env (default Cantonese_Articulate_commentator_vv2).", available: true },
];

// OpenRouter model catalog. Add/remove freely — values are the canonical
// OpenRouter model slugs sent in the `model` field.
export const OPENROUTER_MODELS: { value: string; label: string }[] = [
  { value: "qwen/qwen3-max", label: "Qwen3 Max" },
  { value: "qwen/qwen3.7-plus", label: "Qwen 3.7 Plus" },
  { value: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B Instruct" },
  { value: "openrouter/owl-alpha", label: "OpenRouter Owl Alpha" },
  { value: "anthropic/claude-3.5-sonnet", label: "Anthropic Claude 3.5 Sonnet" },
  { value: "anthropic/claude-3.5-haiku", label: "Anthropic Claude 3.5 Haiku" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek V3" },
  { value: "deepseek/deepseek-r1", label: "DeepSeek R1 (reasoning)" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
  { value: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini" },
  { value: "openai/gpt-4o", label: "OpenAI GPT-4o" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (via OpenRouter)" },
  { value: "x-ai/grok-4", label: "xAI Grok 4 (via OpenRouter)" },
];

export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-max";
// Synthesiser uses a non-reasoning model: no thinking chain → 2–4 s response.
export const DEFAULT_OPENROUTER_SYNTH_MODEL = "qwen/qwen-2.5-72b-instruct";

export const DEFAULT_GREETING_MODEL = "qwen/qwen-2.5-7b-instruct";

// Synthesiser-specific model list (fast, non-reasoning models preferred).
// These are presented in a separate dropdown from the planner model.
export const OPENROUTER_SYNTH_MODELS: { value: string; label: string }[] = [
  { value: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B Instruct (recommended — fast, no reasoning)" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek V3 (fast, no reasoning)" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct (fast, no reasoning)" },
  { value: "openai/gpt-4o-mini", label: "OpenAI GPT-4o Mini (fast, no reasoning)" },
  { value: "qwen/qwen3-max", label: "Qwen3 Max (reasoning — slow for synthesis, not recommended)" },
];

// Fast greeting-specific models, all via OpenRouter.
// Kept separate from OPENROUTER_MODELS so the user can pick a cheap/fast model
// for the 1–2 sentence personalised greeting without affecting the synthesiser.
export const GREETING_MODELS: { value: string; label: string }[] = [
  { value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash (fastest, ~1–2s)" },
  { value: "qwen/qwen-2.5-7b-instruct", label: "Qwen 2.5 7B Instruct (fast, ~2–3s)" },
  { value: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B Instruct (quality, ~4–6s)" },
];

// Module-level provider cache — avoids repeated Supabase reads per pipeline run.
let _providerCache: {
  value: {
    llm: LlmProvider;
    tts: TtsProvider;
    openrouterModel: string;
    openrouterSynthModel: string;
    greetingModel: string;
    grokPlannerModel: string;
    grokSynthModel: string;
  };
  exp: number;
} | null = null;

export function clearProviderCache(): void {
  _providerCache = null;
}

export async function readProvidersServerSide(): Promise<{
  llm: LlmProvider;
  tts: TtsProvider;
  openrouterModel: string;
  openrouterSynthModel: string;
  greetingModel: string;
  grokPlannerModel: string;
  grokSynthModel: string;
}> {
  if (_providerCache && Date.now() < _providerCache.exp) {
    return _providerCache.value;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("key, value")
    .in("key", [
      LLM_KEY,
      TTS_KEY,
      OPENROUTER_MODEL_KEY,
      OPENROUTER_SYNTH_MODEL_KEY,
      GREETING_MODEL_KEY,
      GROK_PLANNER_MODEL_KEY,
      GROK_SYNTH_MODEL_KEY,
    ]);
  const map = new Map<string, string>(
    (data ?? []).map((r) => [r.key as string, r.value as string]),
  );
  const llmRaw = map.get(LLM_KEY) as LlmProvider | undefined;
  const ttsRaw = map.get(TTS_KEY) as TtsProvider | undefined;
  const orRaw = map.get(OPENROUTER_MODEL_KEY);
  const orSynthRaw = map.get(OPENROUTER_SYNTH_MODEL_KEY);
  const grRaw = map.get(GREETING_MODEL_KEY);
  const grokPlannerRaw = map.get(GROK_PLANNER_MODEL_KEY);
  const grokSynthRaw = map.get(GROK_SYNTH_MODEL_KEY);
  const value = {
    llm: (["gemini", "qwen", "grok", "openrouter"] as const).includes(llmRaw as LlmProvider)
      ? (llmRaw as LlmProvider)
      : "gemini",
    tts: (["google", "minimax"] as const).includes(ttsRaw as TtsProvider)
      ? (ttsRaw as TtsProvider)
      : "google",
    openrouterModel: orRaw && orRaw.trim() ? orRaw : DEFAULT_OPENROUTER_MODEL,
    openrouterSynthModel:
      orSynthRaw && orSynthRaw.trim() ? orSynthRaw : DEFAULT_OPENROUTER_SYNTH_MODEL,
    greetingModel: grRaw && grRaw.trim() ? grRaw : DEFAULT_GREETING_MODEL,
    grokPlannerModel:
      grokPlannerRaw && grokPlannerRaw.trim() ? grokPlannerRaw : DEFAULT_GROK_PLANNER_MODEL,
    grokSynthModel:
      grokSynthRaw && grokSynthRaw.trim() ? grokSynthRaw : DEFAULT_GROK_SYNTH_MODEL,
  };
  _providerCache = { value, exp: Date.now() + 5 * 60 * 1000 };
  return value;
}

export const getProviderSettings = createServerFn({ method: "GET" }).handler(
  async () => readProvidersServerSide(),
);

export const saveProviderSettings = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        llm: z.enum(["gemini", "qwen", "grok", "openrouter"]).optional(),
        tts: z.enum(["google", "minimax"]).optional(),
        openrouterModel: z.string().min(1).max(200).optional(),
        openrouterSynthModel: z.string().min(1).max(200).optional(),
        greetingModel: z.string().min(1).max(200).optional(),
        grokPlannerModel: z.string().min(1).max(200).optional(),
        grokSynthModel: z.string().min(1).max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const rows: { key: string; value: string; updated_at: string }[] = [];
    const now = new Date().toISOString();
    if (data.llm) rows.push({ key: LLM_KEY, value: data.llm, updated_at: now });
    if (data.tts) rows.push({ key: TTS_KEY, value: data.tts, updated_at: now });
    if (data.openrouterModel)
      rows.push({ key: OPENROUTER_MODEL_KEY, value: data.openrouterModel, updated_at: now });
    if (data.openrouterSynthModel)
      rows.push({ key: OPENROUTER_SYNTH_MODEL_KEY, value: data.openrouterSynthModel, updated_at: now });
    if (data.greetingModel)
      rows.push({ key: GREETING_MODEL_KEY, value: data.greetingModel, updated_at: now });
    if (data.grokPlannerModel)
      rows.push({ key: GROK_PLANNER_MODEL_KEY, value: data.grokPlannerModel, updated_at: now });
    if (data.grokSynthModel)
      rows.push({ key: GROK_SYNTH_MODEL_KEY, value: data.grokSynthModel, updated_at: now });
    if (rows.length === 0) return { ok: true };
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert(rows, { onConflict: "key" });
    if (error) throw new Error(`Save providers failed: ${error.message}`);
    clearProviderCache();
    return { ok: true };
  });

