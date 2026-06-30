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
        .select("summary_date, conversation_summary, created_at")
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
      created_at?: string;
    }>;
    const memoryContext =
      memRows.length > 0
        ? memRows
            .map((r, i) => `[往績 ${i + 1}] ${r.conversation_summary}`)
            .join("\n")
        : "";

    // Extract first ~200 chars of hk_weather block for greeting context.
    // Guard against placeholder strings (e.g. "@InjectWeather") left in DB.
    const weatherRow = cacheRows.find((r) => r.topic === "hk_weather");
    const rawWeatherSnippet = weatherRow?.content?.slice(0, 200) ?? "";
    const weatherSnippet = /^@[A-Za-z]/.test(rawWeatherSnippet.trim())
      ? ""
      : rawWeatherSnippet;

    const lastMemorySummary = memRows[0]?.conversation_summary ?? null;
    const daysSinceLastSession = (() => {
      if (!memRows[0]?.created_at) return null;
      const lastDate = new Date(memRows[0].created_at);
      const nowHK = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }),
      );
      const diffMs = nowHK.getTime() - lastDate.getTime();
      return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    })();

    return {
      contextText,
      promptTemplate,
      personaName,
      prefetchContext,
      memoryContext,
      cacheMeta,
      weatherSnippet,
      lastMemorySummary,
      daysSinceLastSession,
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

        // hk_weather is already a pre-formatted structured block from HKO
        // Open Data APIs — do NOT run it through the LLM summariser (would
        // drop warning structure and risk hallucination). Store as-is.
        const content =
          topic === "hk_weather"
            ? rawContent
            : await summariseTopic(rawContent, topic);
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

// Fetch HK weather as a pre-formatted structured block via three official
// HKO Open Data JSON endpoints (rhrread / warningInfo / flw). Replaces the
// previous web_search / textonly scrape which returned stale Brave-cached
// data. Returned string is stored directly into daily_cache.hk_weather
// without LLM summarisation.
async function fetchHKOWeather(): Promise<string> {
  const HKO_BASE =
    "https://data.weather.gov.hk/weatherAPI/opendata/weather.php";

  async function fetchHkoApi(
    dataType: string,
  ): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${HKO_BASE}?dataType=${dataType}&lang=tc`);
      if (!res.ok) return {};
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  const [rhrread, warningInfo, flw] = await Promise.all([
    fetchHkoApi("rhrread"),
    fetchHkoApi("warningInfo"),
    fetchHkoApi("flw"),
  ]);

  // ── Active warnings ─────────────────────────────────────────────────
  const WARNING_NAMES: Record<string, Record<string, string>> = {
    WRAIN: {
      AMBER: "黃色暴雨警告",
      RED: "紅色暴雨警告",
      BLACK: "黑色暴雨警告",
    },
    TC: {
      ONE: "一號戒備信號",
      THREE: "三號強風信號",
      EIGHT: "八號烈風或暴風信號",
      NINE: "九號烈風或暴風風力增強信號",
      TEN: "十號颶風信號",
    },
    HOT: { "": "酷熱天氣警告" },
    COLD: { "": "寒冷天氣警告" },
    FIRE: { "": "火災危險警告" },
    SWIND: { "": "強烈季候風信號" },
    FNTSA: { "": "霜凍警告" },
  };

  type WarnDetail = {
    warningStatementCode?: string;
    subtype?: string;
    actionCode?: string;
  };
  const details = (warningInfo.details ?? []) as WarnDetail[];
  const activeWarnings = details
    .filter((d) => d.actionCode !== "CANCEL")
    .map((d) => {
      const names = WARNING_NAMES[d.warningStatementCode ?? ""] ?? {};
      return (
        names[d.subtype ?? ""] ??
        names[""] ??
        d.warningStatementCode ??
        ""
      );
    })
    .filter(Boolean);

  const warningBlock =
    activeWarnings.length > 0
      ? `\n⚠️ 生效警告：${activeWarnings.join("、")}`
      : "";

  // ── Current readings ────────────────────────────────────────────────
  type Reading = { place?: string; value?: number; desc?: string };
  const temps =
    ((rhrread.temperature as { data?: Reading[] } | undefined)?.data ??
      []) as Reading[];
  const observatory = temps.find((t) => t.place === "香港天文台");
  const humidity = (
    (rhrread.humidity as { data?: Reading[] } | undefined)?.data ?? []
  )[0]?.value;
  const uv = (
    (rhrread.uvindex as { data?: Reading[] } | undefined)?.data ?? []
  )[0];

  const readingsBlock = [
    observatory ? `現時氣溫（天文台）：${observatory.value}°C` : "",
    humidity != null ? `相對濕度：${humidity}%` : "",
    uv ? `紫外線指數：${uv.value}（${uv.desc}）` : "",
  ]
    .filter(Boolean)
    .join("，");

  // ── Forecast narrative ──────────────────────────────────────────────
  const generalSituation = (flw.generalSituation as string | undefined) ?? "";
  const forecastDesc = (flw.forecastDesc as string | undefined) ?? "";
  const outlook = (flw.outlook as string | undefined) ?? "";
  const updateTime = (flw.updateTime as string | undefined) ?? "";

  const forecastBlock = [
    generalSituation,
    forecastDesc,
    outlook ? `展望：${outlook}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `【hk_weather】${warningBlock}`,
    readingsBlock,
    forecastBlock,
    updateTime ? `（更新時間：${updateTime}）` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
    const { text: out, usedModel: cacheModel } = await callUtilityChat({
      system: systemPrompt,
      user: `原始資料：\n${raw.slice(0, 3000)}`,
      maxTokens: 600,
    });
    console.log(
      `[${new Date().toISOString()}] 📦 daily-cache-summarize · topic=${topic} · model=${cacheModel}`,
    );
    return out && out.length > 0 ? out : raw.slice(0, 1000);
  } catch (e) {
    console.error(`[VoiceSession] summarise ${topic} failed:`, e);
    return raw.slice(0, 1000);
  }
}

// Keep CACHE_TOPICS exported reference avoidance — referenced for documentation.
void CACHE_TOPICS;
