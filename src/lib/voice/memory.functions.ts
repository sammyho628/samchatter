import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SummarizeInput = z.object({
  sessionId: z.string().min(1),
  transcript: z.string().min(1).max(60000),
  executedSearches: z.array(z.string()).default([]),
});

export const summarizeAndSaveSession = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SummarizeInput.parse(d))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const resp = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": key,
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            {
              role: "system",
              content:
                "Summarize this Cantonese voice chat transcript between an AI companion and 明囡 in 2-3 short Traditional Chinese sentences. Capture: what she asked about, what she shared, mood. Skip greetings/filler. Output ONLY the summary text, no preamble.",
            },
            { role: "user", content: data.transcript },
          ],
          max_tokens: 300,
        }),
      },
    );

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Summarize failed ${resp.status}: ${t.slice(0, 200)}`);
    }
    const j = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = j.choices?.[0]?.message?.content?.trim() ?? "";
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
