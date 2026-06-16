import { createServerFn } from "@tanstack/react-start";

export const getVoiceSession = createServerFn({ method: "GET" }).handler(
  async () => {
    // GEMINI_API_KEY is no longer required — Qwen is used via the server proxy
    // (DASHSCOPE_API_KEY is read inside the proxy route, not here).
    const geminiKey = process.env.GEMINI_API_KEY ?? "";

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await supabaseAdmin
      .from("Voice-Bot-1")
      .select("content_text");

    if (error) {
      throw new Error(`Context load failed: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{ content_text: string | null }>;
    const contextText = rows
      .map((r) => (r.content_text ?? "").trim())
      .filter(Boolean)
      .join("\n\n");

    return { geminiKey, contextText };
  },
);
