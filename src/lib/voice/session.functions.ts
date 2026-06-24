import { createServerFn } from "@tanstack/react-start";
import {
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  DEFAULT_PERSONA_NAME,
} from "./systemPrompt";
import { callUtilityChat } from "./modelRouter";

const PROMPT_KEY = "voice.systemPromptTemplate.v1";
const PERSONA_KEY = "voice.personaName.v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for weather + news
const US_MARKET_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours for US market
const CACHE_TOPICS = ["hk_weather", "hk_news", "us_market_morning"];

function isHKMorning(): boolean {
  const hkHour = parseInt(
    new Date().toLocaleString("en-CA", {
      timeZone: "Asia/Hong_Kong",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
  return hkHour >= 6 && hkHour < 11;
}

function ttlForTopic(topic: string): number {
  return topic === "us_market_morning" ? US_MARKET_TTL_MS : CACHE_TTL_MS;
}

export const getVoiceSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const activeTopics = isHKMorning()
      ? ["hk_weather", "hk_news", "us_market_morning"]
      : ["hk_weather", "hk_news"];

    const [ctxRes, promptRes, personaRes, cacheRes, memRes] = await Promise.all([
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
        .from("app_settings")
        .select("value")
        .eq("key", PERSONA_KEY)
        .maybeSingle(),
      supabaseAdmin
        .from("daily_cache")
        .select("topic, content, updated_at")
        .in("topic", activeTopics),
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

    const personaName =
      ((personaRes.data?.value as string | undefined) ?? "").trim() ||
      DEFAULT_PERSONA_NAME;

    const now = Date.now();
    let cacheRows = (cacheRes.data ?? []) as Array<{
      topic: string;
      content: string;
      updated_at: string;
    }>;
    const staleTopics: string[] = [];
    for (const t of activeTopics) {
      const row = cacheRows.find((r) => r.topic === t);
      if (!row || now - new Date(row.updated_at).getTime() > ttlForTopic(t)) {
        staleTopics.push(t);
      }
    }

    if (staleTopics.length > 0) {
      console.log(
        "[VoiceSession] Refreshing stale cache topics (awaited):",
        staleTopics.join(", "),
      );
      await refreshTopicsBackground(staleTopics).catch((e) => {
        console.error("[VoiceSession] Cache refresh failed:", e);
      });
      const reread = await supabaseAdmin
        .from("daily_cache")
        .select("topic, content, updated_at")
        .in("topic", activeTopics);
      cacheRows = (reread.data ?? []) as typeof cacheRows;
    }

    const prefetchContext = cacheRows
      .map((r) => `【${r.topic}】\n${r.content}`)
      .join("\n\n");

    const cacheMeta = cacheRows.map((r) => ({
      topic: r.topic,
      updated_at: r.updated_at,
      chars: r.content.length,
    }));

    const memRows = (memRes.data ?? []) as Array<{
      summary_date: string;
      conversation_summary: string;
    }>;
    const memoryContext = memRows
      .map((m) => `【往績】${m.summary_date}：${m.conversation_summary}`)
      .join("\n");

    return {
      contextText,
      promptTemplate,
      personaName,
      prefetchContext,
      memoryContext,
      cacheMeta,
    };
  },
);

async function refreshTopicsBackground(topics: string[]) {
  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );

  await Promise.all(
    topics.map(async (topic) => {
      try {
        let rawContent = "";
        if (topic === "hk_weather") {
          rawContent = await fetchHKOWeather();
        } else if (topic === "hk_news") {
          rawContent = await scrapeViaEdge([
            "https://news.rthk.hk/rthk/ch/latest-news.htm",
            "https://hk.yahoo.com/",
          ]);
        } else if (topic === "us_market_morning") {
          rawContent = await scrapeViaEdge([
            "https://tradingeconomics.com/united-states/stock-market",
          ]);
        }

        if (!rawContent) {
          console.warn(`[VoiceSession] ${topic} returned empty content`);
          return;
        }

        const content = await summariseTopic(rawContent, topic);
        const { error } = await supabaseAdmin
          .from("daily_cache")
          .upsert(
            { topic, content, updated_at: new Date().toISOString() },
            { onConflict: "topic" },
          );
        if (error) {
          console.error(
            `[VoiceSession] daily_cache upsert ${topic} failed:`,
            error.message,
          );
        } else {
          console.log(
            `[VoiceSession] daily_cache refreshed ${topic} (${content.length} chars)`,
          );
        }
      } catch (e) {
        console.error(`[VoiceSession] refresh ${topic} failed:`, e);
      }
    }),
  );
}

async function fetchHKOWeather(): Promise<string> {
  const BASE = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php";
  const [flwResp, fndResp, rhrResp] = await Promise.all([
    fetch(`${BASE}?dataType=flw&lang=tc`),
    fetch(`${BASE}?dataType=fnd&lang=tc`),
    fetch(`${BASE}?dataType=rhrread&lang=tc`),
  ]);

  const TARGET_DISTRICTS = ["東區", "赤柱", "沙田", "西貢", "中西區"];
  const parts: string[] = [];

  if (flwResp.ok) {
    const flw = (await flwResp.json()) as {
      generalSituation?: string;
      forecastPeriod?: string;
      forecastDesc?: string;
      outlook?: string;
    };
    parts.push(
      `[本港天氣預報]\n${flw.generalSituation ?? ""}\n${flw.forecastPeriod ?? ""}: ${flw.forecastDesc ?? ""}\n展望: ${flw.outlook ?? ""}`,
    );
  }

  if (fndResp.ok) {
    const fnd = (await fndResp.json()) as {
      weatherForecast?: Array<{
        forecastDate?: string;
        week?: string;
        forecastWeather?: string;
        forecastMaxtemp?: { value?: number };
        forecastMintemp?: { value?: number };
        PSR?: string;
      }>;
    };
    const days = (fnd.weatherForecast ?? [])
      .slice(0, 4)
      .map(
        (d) =>
          `${d.forecastDate} (${d.week}): ${d.forecastWeather} 最高${d.forecastMaxtemp?.value}°C 最低${d.forecastMintemp?.value}°C 降雨概率:${d.PSR}`,
      );
    parts.push(`[九天預報(首4天)]\n${days.join("\n")}`);
  }

  if (rhrResp.ok) {
    const rhr = (await rhrResp.json()) as {
      temperature?: { data?: Array<{ place?: string; value?: number }> };
      humidity?: { data?: Array<{ place?: string; value?: number }> };
    };
    const tempArr = rhr.temperature?.data ?? [];
    const humArr = rhr.humidity?.data ?? [];
    const temps = tempArr
      .filter((t) => TARGET_DISTRICTS.some((d) => t.place?.includes(d)))
      .map((t) => `${t.place}: ${t.value}°C`);
    const hums = humArr
      .filter((h) => TARGET_DISTRICTS.some((d) => h.place?.includes(d)))
      .map((h) => `${h.place}: ${h.value}%`);
    if (temps.length > 0) parts.push(`[各區氣溫]\n${temps.join(", ")}`);
    if (hums.length > 0) parts.push(`[各區濕度]\n${hums.join(", ")}`);
  }

  return parts.join("\n\n");
}

async function scrapeViaEdge(urls: string[]): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anon =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !anon) return "";

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/web-scrape`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anon,
            Authorization: `Bearer ${anon}`,
          },
          body: JSON.stringify({ url }),
        });
        if (!r.ok) return "";
        const j = (await r.json()) as { summary?: string };
        return j.summary ?? "";
      } catch {
        return "";
      }
    }),
  );

  return results.filter(Boolean).join("\n\n---\n\n").slice(0, 4000);
}

async function summariseTopic(raw: string, topic: string): Promise<string> {
  const now = new Date();
  const hkDateFull = now.toLocaleString("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    dateStyle: "full",
    timeStyle: "short",
  });
  const hkDateISO = now.toLocaleString("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateContext = `今日日期時間（香港）：${hkDateFull}（${hkDateISO}）。所有「今日」「明日」「後日」「本週」必須以此日期為基準計算。`;

  const topicInstructions: Record<string, string> = {
    hk_weather: `${dateContext}\n\n你係香港天氣播報員。根據以下 HKO 天文台 API 數據，用繁體中文（香港口語）寫一段簡短天氣播報（200字內）。重點：今日天氣概況、各區氣溫（東區、赤柱、沙田、西貢、中西區）、明日展望。要有點個人色彩，例如「今日出街記得帶遮」呢類貼心提示。唔好用 markdown，純文字。`,
    hk_news: `${dateContext}\n\n你係香港新聞編輯。根據以下網頁內容，用繁體中文（香港）總結今日 3-5 條最重要新聞頭條，每條一句。唔好用 markdown，純文字。`,
    us_market_morning: `${dateContext}\n\n你係財經播報員。根據以下數據，用繁體中文（香港）簡短總結美國股市昨晚表現（道指、標普500、納指方向及幅度），並點出主要原因（如有）。100字內。唔好用 markdown，純文字。`,
  };

  const systemPrompt =
    topicInstructions[topic] ??
    `${dateContext}\n\n請用繁體中文（香港）將以下內容總結成簡短播報稿（200字內）。唔好用 markdown，純文字。`;

  try {
    const out = await callUtilityChat({
      system: systemPrompt,
      user: `原始資料：\n${raw.slice(0, 3000)}`,
      maxTokens: 600,
    });
    return out && out.length > 0 ? out : raw.slice(0, 1000);
  } catch (e) {
    console.error(`[VoiceSession] summarise ${topic} failed:`, e);
    return raw.slice(0, 1000);
  }
}

// Keep CACHE_TOPICS exported reference avoidance — referenced for documentation.
void CACHE_TOPICS;
