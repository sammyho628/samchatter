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
            "Optional. health | stocks | finance | hk_news | world_news | shopping | weather | sports | transport | travel | government | technology",
        },
      },
      required: ["query"],
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
  "美國", "中國", "內地", "大陸", "台灣", "日本", "韓國", "東京", "北京", "上海", "新加坡",
  "英國", "倫敦", "紐約", "美股", "a股", "日經",
  "usa", "china", "taiwan", "japan", "korea", "tokyo", "beijing", "shanghai",
  "singapore", "uk", "london", "new york", "nasdaq", "s&p", "dow",
];
// world_news + technology stay excluded — appending "香港" would bias them.
const LOCAL_CATEGORIES = new Set([
  "hk_news", "health", "stocks", "finance", "shopping",
  "weather", "sports", "transport", "travel", "government",
]);

const SPORTS_RE =
  /(世界盃|世界杯|歐國盃|歐冠|英超|西甲|意甲|德甲|法甲|港超|nba|epl|mlb|nfl|ufc|世錦|奧運|溫網|美網|法網|澳網|f1|grand prix|決賽|準決賽|分組賽|vs |對|球賽|比分|賽果|score|match)/i;

const TICKER_RE = /\b\d{3,5}\.HK\b|\^[A-Z]{2,5}\b|\b[A-Z]{1,5}(?:\.[A-Z]{1,3})?\b\s*(?:stock|股價|股票|報價|quote)/i;
const FINANCE_RE =
  /(股價|股票|報價|收市|開市|恆指|恆生|港股|美股|a股|日經|納指|道指|nasdaq|s&p|dow|stock|ticker|quote|exchange rate|匯率|加密幣|btc|eth|bitcoin|ethereum)/i;
function isFinanceQuery(q: string): boolean {
  return FINANCE_RE.test(q) || TICKER_RE.test(q);
}
function extractTicker(q: string): string | null {
  const m = q.match(/\b\d{3,5}\.HK\b|\^[A-Z]{2,5}\b/i);
  return m ? m[0].toUpperCase() : null;
}

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
  const localHint =
    LOCAL_CATEGORIES.has(category.toLowerCase()) ||
    /(天氣|氣溫|溫度|落雨|打風|新聞|頭條|交通|塞車|股市|股價|匯率|油價|樓價|地震|颱風|空氣|aqi|weather|temperature|news|traffic|stock)/i.test(
      q,
    );
  if (!localHint) return q;
  return `${q} 香港`;
}

function snippetHasScore(summary: string): boolean {
  return /\b\d{1,3}\s*[:\-–vs比]\s*\d{1,3}\b/i.test(summary);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await sleep(2000);
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

  // Finance Guard — ONLY for explicit stock-quote queries (category=stocks or
  // ticker/stock keywords). General finance topics (MPF, insurance, HKMA
  // rules) must NOT trigger Yahoo+Google dual-source comparison.
  if (category === "stocks" || (isFinanceQuery(query) && category !== "finance")) {
    const ticker = extractTicker(query);
    const tickerLabel = ticker ?? "(no ticker)";
    const googleQ = ticker
      ? `${ticker} Google Finance price change`
      : `${query.replace(/yahoo finance/gi, "").trim()} Google Finance price change`;
    await sleep(2000);
    const google = await callEdgeSearch(fn, {
      query: googleQ,
      category: "stocks",
      priority: 2,
    });
    summary =
      `[FINANCE GUARD — ticker=${tickerLabel}]\n` +
      `規則: 只可引用緊貼「${tickerLabel}」或公司全名後面嘅數字。其他 ticker 旁邊嘅數字當噪音、唔好用。\n` +
      `Sanity: Price < Prev Close → 必須跌；Price > Prev Close → 必須升。如果唔夾，必須講「數據顯示有衝突，我重新幫你查一次。」然後重新 search。\n` +
      `如果 Yahoo 同 Google 兩邊主數字差超過 1%，亦觸發 SAFETY TRIGGER。\n\n` +
      `[YAHOO FINANCE SOURCE]\n${summary}\n\n[GOOGLE FINANCE SOURCE]\n${google}`;
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
  const json = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  };
  return { parts: json.candidates?.[0]?.content?.parts ?? [] };
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

const PLANNER_DIRECTIVE = `\n\n[PLANNER ROLE]
You are in PLANNING phase. Decide which tool calls (web_search / search_places) are needed to answer the user. If multiple facets matter (analytical query: 分析/analyse/summary/總結/報告/詳細/深入), emit at least 3 parallel tool calls covering distinct angles. If no tool is needed (greeting, chit-chat, opinion already in context), reply directly with a short Cantonese answer. Do NOT fabricate facts. Tool args should be concise keyword queries, not the user's raw sentence.`;

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
    const text = parts
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
      .trim();
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
- FINANCE: If TOOL_DATA has [FINANCE GUARD] block and DRAFT's price/change direction conflict (price down but says rise, or vice versa), OR draft uses a number from a different ticker than the one requested, OR Yahoo vs Google numbers in TOOL_DATA differ >1% and draft picks one without flagging → status=INCOMPLETE, feedback must instruct: 講「數據顯示有衝突，我重新幫你查一次。」然後重 search Yahoo Finance + 完整 ticker。
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

    const MAX_REFINEMENTS = 2;
    for (let loop = 0; loop < MAX_REFINEMENTS; loop++) {
      if (data.toolResults.length === 0) break;
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

    const MAX_REFINEMENTS = 2;
    for (let loop = 0; loop < MAX_REFINEMENTS; loop++) {
      if (toolResults.length === 0) break;
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
