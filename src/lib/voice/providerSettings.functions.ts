// Provider selection (LLM brain + TTS mouth). Stored in app_settings so the
// user can change it from /instruction without redeploying.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type LlmProvider = "gemini" | "qwen" | "grok";
export type TtsProvider = "google" | "minimax";

const LLM_KEY = "voice.llmProvider";
const TTS_KEY = "voice.ttsProvider";

export const LLM_PROVIDERS: { value: LlmProvider; label: string; note: string }[] = [
  { value: "gemini", label: "Google Gemini 2.5 Flash", note: "Default. Strong Cantonese + tool use." },
  { value: "qwen", label: "Alibaba Qwen (DashScope)", note: "Needs DASHSCOPE_API_KEY." },
  { value: "grok", label: "xAI Grok", note: "Needs XAI_API_KEY." },
];

export const TTS_PROVIDERS: { value: TtsProvider; label: string; note: string; available: boolean }[] = [
  { value: "google", label: "Google Gemini TTS", note: "Cantonese voices.", available: true },
  { value: "minimax", label: "MiniMax speech-02-hd", note: "Cantonese (Yue) boosted. Voice via MINIMAX_VOICE_ID env (default Cantonese_Articulate_commentator_vv2).", available: true },
];

export async function readProvidersServerSide(): Promise<{
  llm: LlmProvider;
  tts: TtsProvider;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("key, value")
    .in("key", [LLM_KEY, TTS_KEY]);
  const map = new Map<string, string>(
    (data ?? []).map((r) => [r.key as string, r.value as string]),
  );
  const llmRaw = map.get(LLM_KEY) as LlmProvider | undefined;
  const ttsRaw = map.get(TTS_KEY) as TtsProvider | undefined;
  return {
    llm: (["gemini", "qwen", "grok"] as const).includes(llmRaw as LlmProvider)
      ? (llmRaw as LlmProvider)
      : "gemini",
    tts: (["google", "minimax"] as const).includes(ttsRaw as TtsProvider)
      ? (ttsRaw as TtsProvider)
      : "google",
  };
}

export const getProviderSettings = createServerFn({ method: "GET" }).handler(
  async () => readProvidersServerSide(),
);

export const saveProviderSettings = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        llm: z.enum(["gemini", "qwen", "grok"]).optional(),
        tts: z.enum(["google", "minimax"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const rows: { key: string; value: string; updated_at: string }[] = [];
    const now = new Date().toISOString();
    if (data.llm) rows.push({ key: LLM_KEY, value: data.llm, updated_at: now });
    if (data.tts) rows.push({ key: TTS_KEY, value: data.tts, updated_at: now });
    if (rows.length === 0) return { ok: true };
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert(rows, { onConflict: "key" });
    if (error) throw new Error(`Save providers failed: ${error.message}`);
    return { ok: true };
  });
