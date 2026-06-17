import { createServerFn } from "@tanstack/react-start";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from "./systemPrompt";

const PROMPT_KEY = "voice.systemPromptTemplate.v1";

export const getVoiceSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const geminiKey = process.env.GEMINI_API_KEY ?? "";

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const [ctxRes, promptRes] = await Promise.all([
      supabaseAdmin
        .from("knowledge_base")
        .select("content_text")
        .order("id", { ascending: true }),
      supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", PROMPT_KEY)
        .maybeSingle(),
    ]);

    if (ctxRes.error) {
      throw new Error(`Context load failed: ${ctxRes.error.message}`);
    }

    const rows = (ctxRes.data ?? []) as Array<{ content_text: string | null }>;
    const contextText = rows
      .map((r) => (r.content_text ?? "").trim())
      .filter(Boolean)
      .join("\n\n");

    const promptTemplate =
      (promptRes.data?.value as string | undefined) ??
      DEFAULT_SYSTEM_PROMPT_TEMPLATE;

    return { geminiKey, contextText, promptTemplate };
  },
);
