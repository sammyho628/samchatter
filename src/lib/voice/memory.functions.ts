import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { callUtilityChat } from "./modelRouter";

const SummarizeInput = z.object({
  sessionId: z.string().min(1),
  transcript: z.string().min(1).max(60000),
  executedSearches: z.array(z.string()).default([]),
});

export const summarizeAndSaveSession = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SummarizeInput.parse(d))
  .handler(async ({ data }) => {
    const summary = await callUtilityChat({
      system:
        "Summarize this Cantonese voice chat transcript between an AI companion and 明囡 in 2-3 short Traditional Chinese sentences. Capture: what she asked about, what she shared, mood. Skip greetings/filler. Output ONLY the summary text, no preamble.",
      user: data.transcript,
      maxTokens: 300,
    });
    if (!summary) throw new Error("Empty summary");

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { error } = await supabaseAdmin.from("chat_memory").insert({
      session_id: data.sessionId,
      conversation_summary: summary,
      executed_searches: data.executedSearches,
    });
    if (error) throw new Error(`Save memory failed: ${error.message}`);
    return { ok: true, summary };
  });
