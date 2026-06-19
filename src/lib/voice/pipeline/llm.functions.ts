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

async function runTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return `Error: missing 'query' for ${name}.`;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anon =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !anon) return "Error: tool backend not configured.";
  const fn =
    name === "search_places"
      ? "search-places"
      : name === "web_search"
        ? "web-search"
        : null;
  if (!fn) return `Error: unknown tool '${name}'.`;
  const body: Record<string, string> = { query };
  if (name === "web_search" && typeof args.category === "string") {
    body.category = args.category;
  }
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
    if (!r.ok) return `Tool ${name} HTTP ${r.status}: ${j.error ?? ""}`;
    return j.summary ?? j.error ?? "No results.";
  } catch (e) {
    return `Tool ${name} threw: ${(e as Error).message}`;
  }
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

export const generateAIResponse = createServerFn({ method: "POST" })
  .inputValidator((d: GenerateInput) => d)
  .handler(async ({ data }) => {
    const { llm } = await readProvidersServerSide();
    const runner =
      llm === "qwen" ? runQwen : llm === "grok" ? runGrok : runGemini;

    const result = await runner(data);
    const text = result.text.trim();
    return {
      // HONESTY: if the brain returned nothing, admit a backend hiccup —
      // do NOT blame the user's microphone (that's Layer 1's job).
      text: text || "（系統處理緊有啲慢，請稍後再試吓啦）",
      history: result.history,
      toolCalls: result.toolCalls,
      provider: llm,
    };
  });
