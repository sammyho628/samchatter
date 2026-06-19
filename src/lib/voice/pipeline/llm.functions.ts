// Layer 2: LLM Brain. Routes to Gemini 2.5 Flash, Qwen (DashScope), or
// xAI Grok based on the voice.llmProvider app_setting. Tool calls
// (web_search / search_places) run server-side and hit the existing
// Supabase Edge Functions.
import { createServerFn } from "@tanstack/react-start";
import { readProvidersServerSide } from "../providerSettings.functions";

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
      "Search the web for current events, news, prices, finance, weather, health facts. Optional category: 'health' | 'finance' | 'news' | 'shopping' picks a curated trusted-domain filter.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up on the web." },
        category: {
          type: "string",
          description: "Optional. health | finance | news | shopping",
        },
      },
      required: ["query"],
    },
  },
];

// Gemini uses uppercase JSONSchema types under functionDeclarations.
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

// OpenAI-style tool definitions for Qwen + Grok.
const OPENAI_TOOLS = TOOL_DECLS.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

// Geo-anchoring: if the query is local-intent (news/weather/finance/places/
// shopping or a generic factual ask) and contains no explicit geography,
// append "香港" so Tavily returns Hong Kong–relevant results.
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
const LOCAL_CATEGORIES = new Set(["news", "health", "finance", "shopping"]);

// Sports-intent hint: forces "live score" suffix + enables retry verification.
const SPORTS_RE =
  /(世界盃|世界杯|歐國盃|歐冠|英超|西甲|意甲|德甲|法甲|港超|nba|epl|mlb|nfl|ufc|世錦|奧運|溫網|美網|法網|澳網|f1|grand prix|決賽|準決賽|分組賽|vs |對|球賽|比分|賽果|score|match)/i;

// Strip conversational filler so the search engine sees keywords only.
// Examples removed: 你好/唔該/我想/睇下/同我/幫我/可唔可以/最新情況/啦/呀/喎/嘅/?/？
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
  // Sports → force precision keywords.
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

// Verification: does snippet actually contain a numeric score? Required
// for sports queries — generic news pages without digits trigger retry.
function snippetHasScore(summary: string): boolean {
  // Look for patterns like "2:1", "2-1", "2 - 1", "贏 3 比 0", "3比2"
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
  body: Record<string, string>,
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

  // web_search
  const category = String(args.category ?? "");
  query = refineQuery(query, category);
  const body: Record<string, string> = { query };
  if (category) body.category = category;
  let summary = await callEdgeSearch(fn, body);

  // RESULT VERIFICATION LOOP — sports queries must contain a numeric score.
  // If first pass returned a generic page, retry once with an aggressive
  // "official score" / "match result" refinement before giving up.
  const isSports = SPORTS_RE.test(query);
  if (isSports && !snippetHasScore(summary)) {
    const retryQuery = `${query.replace(/\s*(live score|比分|賽果)\s*/gi, " ").trim()} match result official score`;
    const retry = await callEdgeSearch(fn, { query: retryQuery, category: category || "news" });
    if (snippetHasScore(retry) || retry.length > summary.length) {
      summary = `${retry}\n\n[fallback from first pass]\n${summary}`;
    }
  }
  return summary;
}

// ---------- Gemini path ----------

async function callGemini(
  key: string,
  systemInstruction: string,
  contents: GeminiTurn[],
): Promise<{ parts: GeminiPart[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        tools: GEMINI_TOOLS,
        generationConfig: { temperature: 0.8, maxOutputTokens: 400 },
      }),
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

async function runGemini(
  data: GenerateInput,
): Promise<{ text: string; history: GeminiTurn[]; toolCalls: ToolCallTrace[] }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY on server");

  const contents: GeminiTurn[] = [
    ...data.history,
    { role: "user", parts: [{ text: data.userText }] },
  ];
  const toolCalls: ToolCallTrace[] = [];

  for (let step = 0; step < 6; step++) {
    const { parts } = await callGemini(key, data.systemInstruction, contents);
    const fnCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, string> } } =>
        "functionCall" in p,
    );
    if (fnCalls.length === 0) {
      const text = parts
        .map((p) => ("text" in p ? p.text : ""))
        .join("")
        .trim();
      contents.push({ role: "model", parts });
      return { text, history: contents, toolCalls };
    }
    contents.push({ role: "model", parts });
    const responses = await Promise.all(
      fnCalls.map(async (p) => {
        const { name, args } = p.functionCall;
        const summary = await runTool(name, args);
        toolCalls.push({ name, args, summary });
        return {
          functionResponse: { name, response: { output: summary } },
        } as GeminiPart;
      }),
    );
    contents.push({ role: "function", parts: responses });
  }
  return { text: "", history: contents, toolCalls };
}

// ---------- OpenAI-compatible path (Qwen + Grok) ----------

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
  // sanitize: only plain text user/model turns survive client-side already
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

async function runOpenAIChat(
  data: GenerateInput,
  cfg: { url: string; model: string; key: string; label: string },
): Promise<{ text: string; history: GeminiTurn[]; toolCalls: ToolCallTrace[] }> {
  const messages: OAMessage[] = [
    { role: "system", content: data.systemInstruction },
    ...historyToOpenAI(data.history),
    { role: "user", content: data.userText },
  ];
  const toolCalls: ToolCallTrace[] = [];

  for (let step = 0; step < 6; step++) {
    const resp = await fetchWithTimeout(
      cfg.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          tools: OPENAI_TOOLS,
          temperature: 0.8,
          max_tokens: 400,
        }),
      },
      15000,
    );
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${cfg.label} ${resp.status}: ${t.slice(0, 500)}`);
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
    const calls = msg?.tool_calls ?? [];
    if (calls.length === 0) {
      const text = (msg?.content ?? "").trim();
      messages.push({ role: "assistant", content: text });
      // Convert back to Gemini-shaped history so the client store stays uniform.
      const history: GeminiTurn[] = [
        ...data.history,
        { role: "user", parts: [{ text: data.userText }] },
        { role: "model", parts: [{ text }] },
      ];
      return { text, history, toolCalls };
    }
    messages.push({
      role: "assistant",
      content: msg?.content ?? null,
      tool_calls: calls,
    });
    for (const c of calls) {
      let args: Record<string, string> = {};
      try {
        args = JSON.parse(c.function.arguments) as Record<string, string>;
      } catch {
        args = {};
      }
      const summary = await runTool(c.function.name, args);
      toolCalls.push({ name: c.function.name, args, summary });
      messages.push({ role: "tool", tool_call_id: c.id, content: summary });
    }
  }
  const history: GeminiTurn[] = [
    ...data.history,
    { role: "user", parts: [{ text: data.userText }] },
  ];
  return { text: "", history, toolCalls };
}

async function runQwen(data: GenerateInput) {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key)
    throw new Error(
      "Missing DASHSCOPE_API_KEY on server (required for Qwen provider).",
    );
  return runOpenAIChat(data, {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    key,
    label: "Qwen",
  });
}

async function runGrok(data: GenerateInput) {
  const key = process.env.XAI_API_KEY;
  if (!key)
    throw new Error(
      "Missing XAI_API_KEY on server (required for Grok provider). Add it under project secrets.",
    );
  return runOpenAIChat(data, {
    url: "https://api.x.ai/v1/chat/completions",
    model: "grok-4-latest",
    key,
    label: "Grok",
  });
}

// ---------- entrypoint ----------

// ---------- Research Agent: Critic layer + Refinement loop ----------

// Detect analytical queries that warrant decomposition + critic review.
const ANALYTICAL_RE =
  /(分析|analyse|analyze|summary|總結|報告|報導|詳細|深入|全面|comprehensive|review|breakdown|睇下整體|完整|綜合)/i;

type CriticVerdict = {
  status: "OK" | "INCOMPLETE" | "LACKS_DEPTH";
  feedback: string;
};

// Critic prompt — runs a hidden LLM pass to check draft quality.
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
- Otherwise → status=OK

Respond ONLY as compact JSON: {"status":"OK|INCOMPLETE|LACKS_DEPTH","feedback":"specific missing fact or what to search next, in Cantonese, <=80 chars"}`;
}

async function evaluateDraft(
  toolData: string,
  draft: string,
): Promise<CriticVerdict> {
  if (!draft.trim() || !toolData.trim()) return { status: "OK", feedback: "" };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { status: "OK", feedback: "" };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: buildCriticPrompt(toolData, draft) }] },
          ],
          generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
        }),
      },
      8000,
    );
    if (!resp.ok) return { status: "OK", feedback: "" };
    const json = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw =
      json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { status: "OK", feedback: "" };
    const parsed = JSON.parse(m[0]) as CriticVerdict;
    if (parsed.status === "INCOMPLETE" || parsed.status === "LACKS_DEPTH") {
      return { status: parsed.status, feedback: String(parsed.feedback ?? "").slice(0, 200) };
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

export const generateAIResponse = createServerFn({ method: "POST" })
  .inputValidator((d: GenerateInput) => d)
  .handler(async ({ data }) => {
    const { llm } = await readProvidersServerSide();
    const runner =
      llm === "qwen" ? runQwen : llm === "grok" ? runGrok : runGemini;

    const isAnalytical = ANALYTICAL_RE.test(data.userText);

    let currentInput: GenerateInput = data;
    let result = await runner(currentInput);
    const allToolCalls: ToolCallTrace[] = [...result.toolCalls];

    // Refinement loop: max 2 critic-driven retries. Only runs when we have
    // tool data to verify against (otherwise the critic has nothing to check).
    const MAX_REFINEMENTS = 2;
    for (let loop = 0; loop < MAX_REFINEMENTS; loop++) {
      if (allToolCalls.length === 0) break;
      const toolData = aggregateToolData(allToolCalls);
      const verdict = await evaluateDraft(toolData, result.text);
      if (verdict.status === "OK") break;

      // Append critic feedback as a correction instruction for the next pass.
      const correction = `[CRITIC FEEDBACK — ${verdict.status}]\n${verdict.feedback}\n請根據以上指示，再 call tool 補資料，然後重新回答（唔好淨係 paraphrase 舊答案）。`;
      currentInput = {
        systemInstruction: data.systemInstruction + "\n\n" + correction,
        history: result.history,
        userText: correction,
      };
      try {
        const refined = await runner(currentInput);
        allToolCalls.push(...refined.toolCalls);
        result = {
          text: refined.text || result.text,
          history: refined.history,
          toolCalls: allToolCalls,
        };
      } catch {
        break;
      }
    }

    const text = result.text.trim();

    return {
      text: text || "（系統處理緊有啲慢，請稍後再試吓啦）",
      history: result.history,
      toolCalls: allToolCalls,
      provider: llm,
      analytical: isAnalytical,
    };
  });

