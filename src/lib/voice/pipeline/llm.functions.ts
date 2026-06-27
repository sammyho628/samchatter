// Layer 2: LLM Brain. Routes to Gemini 2.5 Flash, Qwen (DashScope), or
// xAI Grok via the ModelRouter. Tool calls (web_search / search_places) run
// server-side and hit the existing Supabase Edge Functions.
//
// v1.15.0 split:
//   - planQueries        → single-pass plan (returns tool calls OR direct answer)
//   - executeToolCall    → orchestrator runs each planned tool here
//   - synthesizeAnswer   → final answer from pre-fetched tool results + critic loop
//   - generateAIResponse → back-compat wrapper around the three above
import { createServerFn } from "@tanstack/react-start";
import { resolveCriticCaller, resolveLlmModel } from "../modelRouter";

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, string> } }
  | {
      functionResponse: {
        name: string;
        response: { output: string };
      };
    };

export type GeminiTurn = {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
};

export type ToolCallTrace = {
  name: string;
  args: Record<string, string>;
  summary: string;
};

export type GenerateInput = {
  systemInstruction: string;
  history: GeminiTurn[];
  userText: string;
};

export type PlannedToolCall = { name: string; args: Record<string, string> };
export type QueryPlan = {
  toolCalls: PlannedToolCall[];
  directAnswer: string;
  analytical: boolean;
};

// ---------- shared tool catalog ----------

const TOOL_DECLS = [
  {
    name: "search_places",
    description:
      "Search for real restaurants, businesses, clinics or locations in Hong Kong. Query MUST be Traditional Chinese characters.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Place query in Traditional Chinese." },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for current events, news, prices, finance, weather, health, sports, transport, travel, government info, technology. Pick a category so we apply the curated trusted-domain tier filter.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up on the web." },
        category: {
          type: "string",
          description:
            "Optional. health | stocks_hk | stocks_us | market_hk | market_us | finance | hk_news | world_news | shopping | weather | weather_global | sports | transport | travel | travel_global | government | technology",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "scrape_page",
    description:
      "Scrape a specific URL via Firecrawl to get live JS-rendered page content. MANDATORY for HK stock queries after 16:00 HKT or on weekends — always scrape https://tradingeconomics.com/hong-kong/stock-market to get the authoritative HK50 closing price from the [Indexes] table. Use for any known URL where live rendered content is needed. NEVER scrape Yahoo Finance URLs (blocked, always fail) or hsi.com.hk (JS-rendered, always empty). Confirmed working: tradingeconomics.com via Firecrawl.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The exact URL to scrape. Must be a complete URL starting with https://.",
        },
        reason: {
          type: "string",
          description: "Brief explanation of what you expect to find at this URL.",
        },
      },
      required: ["url"],
    },
  },

];

const GEMINI_TOOLS = [
  {
    functionDeclarations: TOOL_DECLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: "OBJECT",
        properties: Object.fromEntries(
          Object.entries(t.parameters.properties).map(([k, v]) => [
            k,
            { type: "STRING", description: (v as { description?: string }).description ?? "" },
          ]),
        ),
        required: t.parameters.required,
      },
    })),
  },
];

const OPENAI_TOOLS = TOOL_DECLS.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

// ---------- query refinement helpers ----------

const HK_HINTS = [
  "香港", "hong kong", "hk", "九龍", "新界", "港島",
  "中環", "尖沙咀", "旺角", "銅鑼灣", "深水埗", "觀塘", "荃灣",
  "沙田", "將軍澳", "元朗", "屯門", "大埔", "東涌", "粉嶺", "上水",
  "恆指", "恆生", "港股", "港元", "港幣",
];
const NON_HK_HINTS = [
  // Countries and regions (Chinese)
  "美國", "中國", "內地", "大陸", "台灣", "日本", "韓國", "歐洲", "澳洲", "加拿大",
  "法國", "德國", "英國", "泰國", "越南", "馬來西亞", "印尼", "菲律賓", "印度",
  "新加坡", "意大利", "西班牙", "荷蘭", "瑞士", "瑞典", "葡萄牙", "希臘",
  // Cities (Chinese)
  "東京", "北京", "上海", "倫敦", "紐約", "深圳", "廣州", "成都", "重慶",
  "武漢", "南京", "杭州", "西安", "珠海", "東莞", "廈門", "三亞", "澳門",
  "曼谷", "吉隆坡", "台北", "首爾", "大阪", "京都", "神戶", "悉尼", "墨爾本",
  "溫哥華", "多倫多", "巴黎", "柏林", "阿姆斯特丹", "羅馬", "巴塞隆拿",
  "馬德里", "杜拜", "胡志明", "河內", "曼徹斯特", "利物浦", "清邁", "普吉",
  // Countries and cities (English — lowercase for case-insensitive match)
  "usa", "china", "taiwan", "japan", "korea", "europe", "australia", "canada",
  "france", "germany", "thailand", "malaysia", "vietnam", "indonesia", "india",
  "italy", "spain", "netherlands", "switzerland",
  "tokyo", "beijing", "shanghai", "singapore", "london", "new york", "shenzhen",
  "guangzhou", "chengdu", "bangkok", "kuala lumpur", "taipei", "seoul", "osaka",
  "kyoto", "sydney", "melbourne", "paris", "berlin", "amsterdam", "dubai",
  "toronto", "vancouver", "rome", "barcelona", "madrid", "manchester", "liverpool",
  "chicago", "los angeles", "san francisco", "miami", "las vegas", "boston",
  "ho chi minh", "hanoi", "chiang mai", "phuket", "bali", "jakarta",
  "moscow", "istanbul", "cairo", "nairobi", "johannesburg",
  // Finance terms (prevent appending 香港 to US/global market queries)
  "dow jones", "s&p", "s&p 500", "nasdaq", "wall street", "nyse", "ftse",
  "nikkei", "dax", "cac 40",
  // Sports leagues (prevent 香港 in global sports queries)
  "premier league", "la liga", "bundesliga", "serie a", "ligue 1",
  "nba", "nfl", "mlb", "nhl", "uefa", "champions league",
];
// world_news + technology stay excluded — appending "香港" would bias them.
const LOCAL_CATEGORIES = new Set([
  "hk_news", "health", "stocks", "finance", "shopping",
  "weather", "transport", "travel", "government",
  // NOTE: "sports" removed — global sports must NOT get "香港" appended.
  // HK-specific sports (港超/香港隊) already caught by HK_HINTS.
]);

const SPORTS_RE =
  /(世界盃|世界杯|歐國盃|歐冠|英超|西甲|意甲|德甲|法甲|港超|nba|epl|mlb|nfl|ufc|世錦|奧運|溫網|美網|法網|澳網|f1|grand prix|決賽|準決賽|分組賽|vs |對|球賽|比分|賽果|score|match)/i;


const CONVERSATIONAL_RE =
  /(你好|哈囉|hello|hi|唔該|請問|我想|我要|可唔可以|可以唔可以|幫我|同我|搵下|睇下|睇吓|查下|查吓|了解一下|最新情況|情況|啦|呀|喎|啊|㗎|喺度|而家|宜家|依家|^\s*嗯+|嗯+\s*$)/gi;

function sanitizeQuery(raw: string): string {
  return raw
    .replace(CONVERSATIONAL_RE, " ")
    .replace(/[?？!！。，,、；;：:「」『』""'']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function refineQuery(rawQuery: string, category: string): string {
  let q = sanitizeQuery(rawQuery);
  if (!q) q = rawQuery.trim();
  if (!q) return q;
  if (SPORTS_RE.test(q) && !/live score|比分|賽果|score/i.test(q)) {
    q = `${q} live score 比分`;
  }
  const lower = q.toLowerCase();
  if (HK_HINTS.some((h) => lower.includes(h.toLowerCase()))) return q;
  if (NON_HK_HINTS.some((h) => lower.includes(h.toLowerCase()))) return q;
  // Detect English proper nouns in location-sensitive queries (e.g. "Sydney weather", "Bangkok restaurants")
  // A word matching /^[A-Z][a-z]{2,}$/ is almost certainly a city/country name in these categories
  // This catches cities not in NON_HK_HINTS without needing an exhaustive list
  if (LOCAL_CATEGORIES.has(category.toLowerCase())) {
    const hasEnglishProperNoun = rawQuery.trim().split(/\s+/).some(w => /^[A-Z][a-z]{2,}$/.test(w));
    if (hasEnglishProperNoun) return q;
  }
  const localHint =
    LOCAL_CATEGORIES.has(category.toLowerCase()) ||
    /(天氣|氣溫|溫度|落雨|打風|新聞|頭條|交通|塞車|港股|股市|股價|匯率|油價|樓價|地震|颱風|空氣|aqi|weather|temperature)/i.test(
      q,
    );
  if (!localHint) return q;
  return `${q} 香港`;
}

function snippetHasScore(summary: string): boolean {
  return /\b\d{1,3}\s*[:\-–vs比]\s*\d{1,3}\b/i.test(summary);
}


async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callEdgeSearch(
  fn: string,
  body: Record<string, string | number>,
): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anon =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !anon) return "Error: tool backend not configured.";
  try {
    const r = await fetchWithTimeout(
      `${supabaseUrl}/functions/v1/${fn}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anon,
          Authorization: `Bearer ${anon}`,
        },
        body: JSON.stringify(body),
      },
      8000,
    );
    const j = (await r.json().catch(() => ({}))) as {
      summary?: string;
      error?: string;
    };
    if (!r.ok) return `HTTP ${r.status}: ${j.error ?? ""}`;
    return j.summary ?? j.error ?? "No results.";
  } catch (e) {
    return `threw: ${(e as Error).message}`;
  }
}

// runTool — single tool call. No hardcoded finance handling: ticker
// extraction, Yahoo/Google dual-source fetch, and Finance Guard prompt
// injection have been removed. The main LLM (selected by ModelRouter) is
// responsible for any finance-specific reasoning via the system prompt.
async function runTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  let query = String(args.query ?? "").trim();

  if (name === "scrape_page") {
    const url = String(args.url ?? "").trim();
    if (!url || !url.startsWith("https://")) {
      return `Error: scrape_page requires a valid https:// URL.`;
    }
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon =
      process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !anon) return "Error: scrape backend not configured.";
    try {
      const r = await fetchWithTimeout(
        `${supabaseUrl}/functions/v1/web-scrape`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anon,
            Authorization: `Bearer ${anon}`,
          },
          body: JSON.stringify({ url }),
        },
        15000,
      );
      const j = (await r.json().catch(() => ({}))) as { summary?: string; error?: string };
      if (!r.ok) return `HTTP ${r.status}: ${j.error ?? ""}`;
      return j.summary ?? "No content returned.";
    } catch (e) {
      return `scrape_page threw: ${(e as Error).message}`;
    }
  }

  if (!query) return `Error: missing 'query' for ${name}.`;
  const fn =
    name === "search_places"
      ? "search-places"
      : name === "web_search"
        ? "web-search"
        : null;
  if (!fn) return `Error: unknown tool '${name}'.`;

  if (name === "search_places") {
    const cleaned = sanitizeQuery(query) || query;
    return callEdgeSearch(fn, { query: cleaned });
  }

  const category = String(args.category ?? "");
  query = refineQuery(query, category);
  const body: Record<string, string | number> = { query };
  if (category) {
    body.category = category;
    // Soft Preference Tier 1 — authoritative sources first.
    body.priority = 1;
  }
  let summary = await callEdgeSearch(fn, body);

  // Sports self-healing loop — if no score in snippet, retry against Tier 2
  // domains (livescore/reuters) with a "match report" hint that prefers text
  // recaps over JS-rendered scoreboards.
  const isSports = SPORTS_RE.test(query) || category === "sports";
  if (isSports && !snippetHasScore(summary)) {
    // No artificial sleep — retry immediately when the first pass returns no score.
    const retryQuery = `${query.replace(/\s*(live score|比分|賽果)\s*/gi, " ").trim()} match report result summary`;
    const retry = await callEdgeSearch(fn, {
      query: retryQuery,
      category: "sports",
      priority: 2,
    });
    if (snippetHasScore(retry) || retry.length > summary.length) {
      summary = `${retry}\n\n[fallback from first pass]\n${summary}`;
    }
  }

  return summary;
}

// ---------- LLM callers (ModelRouter-driven) ----------

async function callGemini(
  key: string,
  model: string,
  systemInstruction: string,
  contents: GeminiTurn[],
  withTools: boolean,
): Promise<{ parts: GeminiPart[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature: 0.8, maxOutputTokens: 400 },
  };
  if (withTools) body.tools = GEMINI_TOOLS;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    15000,
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${t.slice(0, 500)}`);
  }
  const json = (await resp.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return { parts };

}

type OAMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OAToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function historyToOpenAI(history: GeminiTurn[]): OAMessage[] {
  const out: OAMessage[] = [];
  for (const t of history) {
    const text = t.parts
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
      .trim();
    if (!text) continue;
    if (t.role === "user") out.push({ role: "user", content: text });
    else if (t.role === "model") out.push({ role: "assistant", content: text });
  }
  return out;
}

async function callOpenAIChat(
  apiUrl: string,
  model: string,
  apiKey: string,
  messages: OAMessage[],
  withTools: boolean,
): Promise<{
  content: string;
  toolCalls: OAToolCall[];
}> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.8,
    max_tokens: 400,
  };
  if (withTools) body.tools = OPENAI_TOOLS;
  const resp = await fetchWithTimeout(
    apiUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    15000,
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`${model} ${resp.status}: ${t.slice(0, 500)}`);
  }
  const json = (await resp.json()) as {
    choices?: Array<{
      message?: {
        role: "assistant";
        content?: string | null;
        tool_calls?: OAToolCall[];
      };
    }>;
  };
  const msg = json.choices?.[0]?.message;
  return {
    content: (msg?.content ?? "").trim(),
    toolCalls: msg?.tool_calls ?? [],
  };
}

// ---------- PLANNER ----------

const PLANNER_DIRECTIVE = `

[PLANNER ROLE]
You are in PLANNING phase. Decide which tool calls (web_search / search_places / scrape_page) are needed to answer the user. If multiple facets matter (analytical query: 分析/analyse/summary/總結/報告/詳細/深入), emit at least 3 parallel tool calls covering distinct angles. If no tool is needed (greeting, chit-chat, opinion already in context), reply directly with a short Cantonese answer. Do NOT fabricate facts. Tool args should be concise keyword queries, not the user's raw sentence.

[HK STOCK MANDATORY RULE — POST-MARKET]
If the user asks about HK stock market / HSI / Hang Seng / 恆指 / 港股 AND the current HK time is after 16:00 HKT or it is a weekend/holiday, ALWAYS plan exactly 2 tools fired simultaneously in one step (never sequentially):
  Tool 1: web_search(category="stocks", query="Hang Seng Index close [today ISO date]")
  Tool 2: scrape_page(url="https://tradingeconomics.com/hong-kong/stock-market", reason="Get authoritative HK50 closing price from Indexes table")
The scraped [Indexes] table value is the AUTHORITATIVE closing price — it overrides any number from the Brave snippet. Brave snippets carry stale CFD values that frequently differ from the actual HSI close.
NEVER say "data not available" post-market — tradingeconomics.com always has the confirmed close by 16:30 HKT.
NEVER invent or estimate a price if neither tool returns a clear number — say "數據暫時攞唔到" instead.

[HK STOCK RULE — OPEN MARKET]
If the user asks about HK stocks during trading hours (Mon–Fri 09:30–16:00 HKT):
  Fire ONLY web_search(category="stocks", query="Hang Seng Index live [today ISO date]").
  Do NOT fire scrape_page — tradingeconomics.com times out during live trading hours (5–19 second delay).

[NON-HK WEATHER MANDATORY RULE — 強制]
If the user asks about weather for a location OUTSIDE Hong Kong (e.g. "Sydney weather", "東京天氣", "Bangkok weather", any city/country that is not Hong Kong):
  → ALWAYS use web_search(category="weather_global", query="[City] weather today") — NOT category="weather"
  → category="weather" is ONLY for Hong Kong — it hard-routes to HKO (site:hko.gov.hk) and country:hk, making it useless for any non-HK city
  → category="weather_global" uses country:us locale + global sources (weather.com, timeanddate.com, bom.gov.au, accuweather.com)
  Detection rule: any query mentioning a city/country name that is NOT 香港/HK/Hong Kong → use weather_global, not weather.
  Examples:
    "悉尼天氣點呀" → web_search(category="weather_global", query="Sydney weather today")
    "東京今日幾度" → web_search(category="weather_global", query="Tokyo weather today")
    "Bangkok weather this week" → web_search(category="weather_global", query="Bangkok weather forecast")
    "London weather tomorrow" → web_search(category="weather_global", query="London weather tomorrow")

[US BROAD MARKET MANDATORY RULE — 強制]
If the user asks about the US broad market (「美股」/「US stock market」/「Wall Street」/「美國股市」/「三大指數」/「道指」/「標普」/「納指」/「Dow Jones」/「S&P 500」/「Nasdaq」) and is NOT asking about a specific named ticker (NVDA/TSLA/AAPL/MSFT/META/GOOG etc.):
During US market hours (21:00–06:00 HKT) — ALWAYS plan exactly 2 tools fired simultaneously:
  Tool 1: web_search(category="stocks", query="Dow Jones S&P 500 Nasdaq live today")
  Tool 2: scrape_page(url="https://tradingeconomics.com/united-states/stock-market", reason="Brave from HK always routes stock keyword searches to HK market pages — scrape bypasses geo-routing and always returns the US [Indexes] table with S&P 500 / Dow Jones / Nasdaq figures")
After US market hours — same 2 tools, change Tool 1 query to: "Dow Jones S&P 500 Nasdaq close today"
If web_search snippet returns HK50/恆指 data (Brave geo-routing bias) → IGNORE the snippet, use scrape result instead.
NEVER fire only web_search for US broad market.

[ITINERARY & DAY-TRIP PLANNING — CLARIFY BEFORE SEARCH — 強制]
If the user requests a day trip, full-day itinerary, or asks to plan a visit to a city (e.g. 「去深圳玩一日」/「計劃東京行程」/「幫我安排一日」/「plan a day in [city]」) WITHOUT specifying:
  (a) which area / district to focus on, AND
  (b) what type of activities (食、購物、文化景點、SPA/按摩、自然景色、咖啡...)
→ DO NOT fire any search tools. Respond tools=0. Ask 1 concise question in 廣東話, offering 3–4 concrete options.
   Good example: "好呀！你今次去深圳主要係想食嘢、按摩SPA定係購物？定係三樣都要？"
   Good example: "東京行程好期待！你住係邊區？同埋主要想食嘢、睇景點定係shopping？"
Exception A: If Personal Context Sheet already has crossing/hotel info → skip location question, ask activity type only.
Exception B: If user says 「你決定啦」or defers → pick sensible defaults from Personal Context Sheet (e.g. 福田區 + 食嘢+按摩) and proceed with tools immediately. Do not ask again.
ONLY fire search tools AFTER receiving the user's activity/area context.

[ITINERARY SEARCH — USE DISTRICT-LEVEL QUERIES — 強制]
When firing search_places or web_search for itinerary venues (restaurants / activities / spas / attractions):
  ALWAYS query at DISTRICT / AREA level, never at specific-venue level.
  CORRECT:   search_places("福田區 粵菜早茶"), search_places("新宿 居酒屋"), web_search("銅鑼灣 下午茶 推薦")
  INCORRECT: search_places("One Avenue 附近 餐廳")     ← locks radius; causes 資訊繭房
  INCORRECT: search_places("皇庭廣場 旁邊 按摩")       ← Personal Context Sheet venue as search keyword
  Personal Context Sheet venue names are reference points ONLY — never embed them as search keywords.
  District-level queries return diverse candidates that can be geographically clustered and sequenced.

[ITINERARY FOLLOW-UP — MANDATORY SEARCH — 強制]
If the user is in an active itinerary conversation (prior turns mention places, times, districts)
and asks for additional venues, food, or activity suggestions (e.g. 「邊度食晚飯？」「仲有咩好玩？」
「搵個按摩地方」「之後去邊？」):
  → MUST fire search_places or web_search — never answer from memory.
  → Hallucinating venue names in a real-world itinerary context is a critical failure.
  → Use the district already established in conversation as the search anchor.
  Examples:
    User (in Shenzhen itinerary): "晚餐去邊好？"
      → search_places("福田區 晚餐 餐廳推薦") — use district from context
    User (in Tokyo itinerary): "仲有咩景點？"
      → web_search(category="travel", query="新宿 景點 推薦") — use district from context
  Exception: if user explicitly says 「你話俾我聽就算」or defers to memory → may use Personal
  Context Sheet favourites, but must still preface with 「呢個係我之前喺記錄見到嘅，唔係最新搜尋結果」.

[SPORTS LIVE STANDINGS MANDATORY RULE]
If the user asks for live/current match results, group standings, tournament rankings, or "who is eliminated/qualified" from an ongoing tournament:
  ALWAYS fire BOTH tools simultaneously in a single plan step:
    Tool 1: web_search(category="sports", query="[tournament] match results [today date]")
    Tool 2: scrape_page(url="https://www.fotmob.com/tournaments/77/worldcup-2026", reason="FotMob renders live World Cup scores — use if BBC blocked. For other tournaments swap tournament ID.")
  Primary scrape targets in priority order (use the first one that is not blocked):
    World Cup: https://www.fotmob.com/tournaments/77/worldcup-2026
    Premier League/general: https://www.bbc.com/sport/football/scores-fixtures
    Fallback: https://www.reuters.com/sports/soccer/
  If the scrape result contains "blocked" / "ERR_BLOCKED" / "edigitalsurvey" → that scrape
  FAILED. Do NOT use it. The synthesiser must treat it as zero data.
  Do NOT fire web_search alone for live sports standings — Brave snippets for Livescore/ESPN/BBC Sport only return page titles and descriptions, never actual score data.
  Exception: if the user asks for general sports news or previews (not live scores/standings), web_search alone is fine.`;


const ANALYTICAL_RE =
  /(分析|analyse|analyze|summary|總結|報告|報導|詳細|深入|全面|comprehensive|review|breakdown|睇下整體|完整|綜合)/i;

async function runPlannerGemini(
  data: GenerateInput,
  key: string,
  model: string,
): Promise<QueryPlan> {
  const contents: GeminiTurn[] = [
    ...data.history,
    { role: "user", parts: [{ text: data.userText }] },
  ];
  const { parts } = await callGemini(
    key,
    model,
    data.systemInstruction + PLANNER_DIRECTIVE,
    contents,
    true,
  );
  const toolCalls: PlannedToolCall[] = [];
  let directAnswer = "";
  for (const p of parts) {
    if ("functionCall" in p) {
      toolCalls.push({ name: p.functionCall.name, args: p.functionCall.args });
    } else if ("text" in p) {
      directAnswer += p.text;
    }
  }
  return {
    toolCalls,
    directAnswer: directAnswer.trim(),
    analytical: ANALYTICAL_RE.test(data.userText),
  };
}

async function runPlannerOpenAI(
  data: GenerateInput,
  cfg: { apiUrl: string; model: string; apiKey: string },
): Promise<QueryPlan> {
  const messages: OAMessage[] = [
    { role: "system", content: data.systemInstruction + PLANNER_DIRECTIVE },
    ...historyToOpenAI(data.history),
    { role: "user", content: data.userText },
  ];
  const { content, toolCalls: oaCalls } = await callOpenAIChat(
    cfg.apiUrl,
    cfg.model,
    cfg.apiKey,
    messages,
    true,
  );
  const toolCalls: PlannedToolCall[] = oaCalls.map((c) => {
    let args: Record<string, string> = {};
    try {
      args = JSON.parse(c.function.arguments) as Record<string, string>;
    } catch {
      args = {};
    }
    return { name: c.function.name, args };
  });
  return {
    toolCalls,
    directAnswer: content,
    analytical: ANALYTICAL_RE.test(data.userText),
  };
}

export const planQueries = createServerFn({ method: "POST" })
  .inputValidator((d: GenerateInput) => d)
  .handler(async ({ data }): Promise<QueryPlan> => {
    const m = await resolveLlmModel();
    if (m.provider === "gemini") return runPlannerGemini(data, m.apiKey, m.model);
    return runPlannerOpenAI(data, {
      apiUrl: m.apiUrl,
      model: m.model,
      apiKey: m.apiKey,
    });
  });

// ---------- EXECUTE TOOL ----------

export const executeToolCall = createServerFn({ method: "POST" })
  .inputValidator((d: PlannedToolCall) => d)
  .handler(async ({ data }): Promise<ToolCallTrace> => {
    const summary = await runTool(data.name, data.args);
    return { name: data.name, args: data.args, summary };
  });

// ---------- SYNTHESISER ----------

export type SynthesizeInput = GenerateInput & {
  toolResults: ToolCallTrace[];
};

function buildToolResultsBlock(toolResults: ToolCallTrace[]): string {
  if (toolResults.length === 0) return "";
  const body = toolResults
    .map(
      (t) =>
        `### ${t.name}(${JSON.stringify(t.args)})\n${t.summary}`,
    )
    .join("\n\n");
  return `\n\n[TOOL RESULTS — use these as the sole source of factual claims]\n${body}\n[/TOOL RESULTS]`;
}

async function callSynthesiser(
  systemInstruction: string,
  history: GeminiTurn[],
  userText: string,
): Promise<{ text: string; history: GeminiTurn[] }> {
  const m = await resolveLlmModel();
  if (m.provider === "gemini") {
    const contents: GeminiTurn[] = [
      ...history,
      { role: "user", parts: [{ text: userText }] },
    ];
    const { parts } = await callGemini(
      m.apiKey,
      m.model,
      systemInstruction,
      contents,
      false,
    );
    let text = "";
    try {
      text =
        (
          parts?.find((p): p is { text: string } =>
            "text" in p && typeof (p as { text?: string }).text === "string",
          )?.text ?? ""
        ).trim();
    } catch {
      text = "";
    }
    contents.push({ role: "model", parts: [{ text }] });
    return { text, history: contents };

  }
  const messages: OAMessage[] = [
    { role: "system", content: systemInstruction },
    ...historyToOpenAI(history),
    { role: "user", content: userText },
  ];
  const { content } = await callOpenAIChat(
    m.apiUrl,
    m.model,
    m.apiKey,
    messages,
    false,
  );
  const nextHistory: GeminiTurn[] = [
    ...history,
    { role: "user", parts: [{ text: userText }] },
    { role: "model", parts: [{ text: content }] },
  ];
  return { text: content, history: nextHistory };
}

// ---------- Critic ----------

type CriticVerdict = {
  status: "OK" | "INCOMPLETE" | "LACKS_DEPTH";
  feedback: string;
};

function buildCriticPrompt(toolData: string, draft: string): string {
  return `You are a strict QA critic. Review the assistant's DRAFT against the TOOL_DATA gathered from searches.

TOOL_DATA:
${toolData.slice(0, 4000)}

DRAFT:
${draft}

Rules:
- If DRAFT says "data not found / 搵唔到 / 暫時冇" BUT TOOL_DATA contains concrete facts (scores, names, dates, numbers) → status=INCOMPLETE
- If DRAFT lacks concrete facts/scores/numbers that TOOL_DATA provides → status=INCOMPLETE
- If DRAFT is a shallow one-liner for an analytical query → status=LACKS_DEPTH
- If DRAFT contradicts itself on direction (e.g. price down but says "rise") or uses numbers not present in TOOL_DATA → status=INCOMPLETE
- Otherwise → status=OK

Respond ONLY as compact JSON: {"status":"OK|INCOMPLETE|LACKS_DEPTH","feedback":"specific missing fact or what to search next, in Cantonese, <=80 chars"}`;
}

async function evaluateDraft(
  toolData: string,
  draft: string,
): Promise<CriticVerdict> {
  if (!draft.trim() || !toolData.trim()) return { status: "OK", feedback: "" };
  const caller = await resolveCriticCaller();
  if (!caller) return { status: "OK", feedback: "" };
  try {
    const raw = await caller(buildCriticPrompt(toolData, draft));
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { status: "OK", feedback: "" };
    const parsed = JSON.parse(m[0]) as CriticVerdict;
    if (parsed.status === "INCOMPLETE" || parsed.status === "LACKS_DEPTH") {
      return {
        status: parsed.status,
        feedback: String(parsed.feedback ?? "").slice(0, 200),
      };
    }
    return { status: "OK", feedback: "" };
  } catch {
    return { status: "OK", feedback: "" };
  }
}

function aggregateToolData(toolCalls: ToolCallTrace[]): string {
  return toolCalls
    .map((t) => `[${t.name} ${JSON.stringify(t.args)}]\n${t.summary}`)
    .join("\n\n---\n\n");
}

export const synthesizeAnswer = createServerFn({ method: "POST" })
  .inputValidator((d: SynthesizeInput) => d)
  .handler(async ({ data }) => {
    const isAnalytical = ANALYTICAL_RE.test(data.userText);
    const toolsBlock = buildToolResultsBlock(data.toolResults);
    let systemInstruction = data.systemInstruction + toolsBlock;
    let history = data.history;
    let userText = data.userText;

    let result = await callSynthesiser(systemInstruction, history, userText);

    const needsCritic =
      data.toolResults.length > 0 &&
      (isAnalytical ||
        data.toolResults.some((t) => {
          const cat = (t.args.category ?? "") as string;
          return (
            ["stocks", "finance", "sports"].includes(cat) ||
            t.name === "scrape_page"
          );
        }));

    const MAX_REFINEMENTS = 2;
    for (let loop = 0; loop < MAX_REFINEMENTS; loop++) {
      if (!needsCritic) break;
      const verdict = await evaluateDraft(
        aggregateToolData(data.toolResults),
        result.text,
      );
      if (verdict.status === "OK") break;
      const correction = `[CRITIC FEEDBACK — ${verdict.status}]\n${verdict.feedback}\n請根據以上指示，重新整理答案（唔好淨係 paraphrase 舊答案；引用 TOOL RESULTS 入面嘅具體事實）。`;
      systemInstruction = data.systemInstruction + toolsBlock + "\n\n" + correction;
      history = result.history;
      userText = correction;
      try {
        result = await callSynthesiser(systemInstruction, history, userText);
      } catch {
        break;
      }
    }

    return {
      text: result.text.trim() || "（系統處理緊有啲慢，請稍後再試吓啦）",
      history: result.history,
      analytical: isAnalytical,
    };
  });

// ---------- Back-compat wrapper ----------
// generateAIResponse still exists for any caller using the single-call API.
// Internally it now runs plan → execute → synthesise sequentially.

export const generateAIResponse = createServerFn({ method: "POST" })
  .inputValidator((d: GenerateInput) => d)
  .handler(async ({ data }) => {
    const m = await resolveLlmModel();
    const plan =
      m.provider === "gemini"
        ? await runPlannerGemini(data, m.apiKey, m.model)
        : await runPlannerOpenAI(data, {
            apiUrl: m.apiUrl,
            model: m.model,
            apiKey: m.apiKey,
          });

    // If the planner produced a direct answer and no tools, return it as-is.
    if (plan.toolCalls.length === 0 && plan.directAnswer) {
      const nextHistory: GeminiTurn[] = [
        ...data.history,
        { role: "user", parts: [{ text: data.userText }] },
        { role: "model", parts: [{ text: plan.directAnswer }] },
      ];
      return {
        text: plan.directAnswer,
        history: nextHistory,
        toolCalls: [] as ToolCallTrace[],
        provider: m.provider,
        analytical: plan.analytical,
      };
    }

    const toolResults: ToolCallTrace[] = await Promise.all(
      plan.toolCalls.map(async (c) => ({
        name: c.name,
        args: c.args,
        summary: await runTool(c.name, c.args),
      })),
    );

    const toolsBlock = buildToolResultsBlock(toolResults);
    let systemInstruction = data.systemInstruction + toolsBlock;
    let history = data.history;
    let userText = data.userText;
    let result = await callSynthesiser(systemInstruction, history, userText);

    const needsCritic =
      toolResults.length > 0 &&
      (plan.analytical ||
        toolResults.some((t) => {
          const cat = (t.args.category ?? "") as string;
          return (
            ["stocks", "finance", "sports"].includes(cat) ||
            t.name === "scrape_page"
          );
        }));

    const MAX_REFINEMENTS = 2;
    for (let loop = 0; loop < MAX_REFINEMENTS; loop++) {
      if (!needsCritic) break;
      const verdict = await evaluateDraft(aggregateToolData(toolResults), result.text);
      if (verdict.status === "OK") break;
      const correction = `[CRITIC FEEDBACK — ${verdict.status}]\n${verdict.feedback}\n請根據以上指示，重新整理答案。`;
      systemInstruction = data.systemInstruction + toolsBlock + "\n\n" + correction;
      history = result.history;
      userText = correction;
      try {
        result = await callSynthesiser(systemInstruction, history, userText);
      } catch {
        break;
      }
    }

    return {
      text: result.text.trim() || "（系統處理緊有啲慢，請稍後再試吓啦）",
      history: result.history,
      toolCalls: toolResults,
      provider: m.provider,
      analytical: plan.analytical,
    };
  });
