import { createServerFn } from "@tanstack/react-start";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from "./systemPrompt";

const PROMPT_KEY = "voice.systemPromptTemplate.v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_TOPICS = ["hk_weather", "hk_news"];

export const getVoiceSession = createServerFn({ method: "GET" }).handler(
  async () => {
    // NOTE: do not return GEMINI_API_KEY — Layer 2 (llm.functions.ts) calls
    // Gemini server-side; the key must never reach the browser.
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const [ctxRes, promptRes, cacheRes, memRes] = await Promise.all([
      supabaseAdmin
        .from("knowledge_base")
        .select("content_text")
        .order("id", { ascending: true }),
      supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", PROMPT_KEY)
        .maybeSingle(),
      supabaseAdmin
        .from("daily_cache")
        .select("topic, content, updated_at")
        .in("topic", CACHE_TOPICS),
      supabaseAdmin
        .from("chat_memory")
        .select("summary_date, conversation_summary")
        .order("created_at", { ascending: false })
        .limit(3),
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

    // Build prefetch_context from daily_cache; trigger background refresh if stale
    const now = Date.now();
    let cacheRows = (cacheRes.data ?? []) as Array<{
      topic: string;
      content: string;
      updated_at: string;
    }>;
    const staleTopics: string[] = [];
    for (const t of CACHE_TOPICS) {
      const row = cacheRows.find((r) => r.topic === t);
      if (!row || now - new Date(row.updated_at).getTime() > CACHE_TTL_MS) {
        staleTopics.push(t);
      }
    }

    // COLD START: if the cache is completely empty, AWAIT the refresh so the
    // very first session of the day has prefetch_context populated. On warm
    // cache (some rows present but stale), fire-and-forget so we don't delay
    // the WebSocket handshake.
    if (cacheRows.length === 0 && staleTopics.length > 0) {
      await refreshTopicsBackground(staleTopics).catch(() => {});
      const reread = await supabaseAdmin
        .from("daily_cache")
        .select("topic, content, updated_at")
        .in("topic", CACHE_TOPICS);
      cacheRows = (reread.data ?? []) as typeof cacheRows;
    } else if (staleTopics.length > 0) {
      void refreshTopicsBackground(staleTopics).catch(() => {});
    }

    const prefetchContext = cacheRows
      .map((r) => `【${r.topic}】\n${r.content}`)
      .join("\n\n");


    // Build memory_context
    const memRows = (memRes.data ?? []) as Array<{
      summary_date: string;
      conversation_summary: string;
    }>;
    const memoryContext = memRows
      .map(
        (m) =>
          `【Past Memory】 On ${m.summary_date}: ${m.conversation_summary}`,
      )
      .join("\n");

    return {
      geminiKey,
      contextText,
      promptTemplate,
      prefetchContext,
      memoryContext,
    };
  },
);

async function refreshTopicsBackground(topics: string[]) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return;
  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );
  const queries: Record<string, string> = {
    hk_weather:
      "香港今日天氣預報 氣溫 降雨 (請以繁體中文 zh-HK 回答，不要使用英文)",
    hk_news:
      "香港今日頭條新聞 (請以繁體中文 zh-HK 回答，不要使用英文) site:rthk.hk OR site:hk01.com OR site:mingpao.com",
  };
  await Promise.all(
    topics.map(async (topic) => {
      const q = queries[topic];
      if (!q) return;
      try {
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tavilyKey}`,
          },
          body: JSON.stringify({
            query: q,
            search_depth: "basic",
            include_answer: true,
            max_results: 3,
          }),
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          answer?: string;
          results?: Array<{ title?: string; content?: string }>;
        };
        const parts: string[] = [];
        if (data.answer) parts.push(data.answer);
        (data.results ?? []).slice(0, 3).forEach((r) => {
          const t = r.title ?? "";
          const c = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
          if (t || c) parts.push(`${t}: ${c}`);
        });
        const rawContent = parts.join("\n").slice(0, 2000);
        if (!rawContent) return;
        const content = await translateToTraditionalChinese(rawContent, topic);
        await supabaseAdmin
          .from("daily_cache")
          .upsert(
            { topic, content, updated_at: new Date().toISOString() },
            { onConflict: "topic" },
          );
      } catch {
        /* ignore */
      }
    }),
  );
}

async function translateToTraditionalChinese(
  raw: string,
  topic: string,
): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return raw;
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You are a Hong Kong news/weather editor. You MUST return the summary EXCLUSIVELY in Traditional Chinese (zh-HK / 繁體中文 香港用語). Do NOT use English, Simplified Chinese, or any other language. Keep it concise (under 400 字). No preamble, no markdown — plain prose only.",
          },
          {
            role: "user",
            content: `主題：${topic}\n\n原始資料：\n${raw}\n\n請用繁體中文（香港）總結成簡短播報稿。`,
          },
        ],
      }),
    });
    if (!r.ok) return raw;
    const j = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = j.choices?.[0]?.message?.content?.trim();
    return out && out.length > 0 ? out : raw;
  } catch {
    return raw;
  }
}
