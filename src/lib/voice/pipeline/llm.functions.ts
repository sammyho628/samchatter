// Layer 2: LLM Brain. Provider: Gemini 2.5 Flash via generateContent REST.
// Runs the tool-call loop server-side: web_search + search_places (re-uses the
// existing Supabase Edge Functions so trusted_domains routing is unchanged).
import { createServerFn } from "@tanstack/react-start";

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
  history: GeminiTurn[]; // prior turns (user/model), excluding the new userText
  userText: string;
};

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "search_places",
        description:
          "Search for real restaurants, businesses, clinics or locations in Hong Kong. Query MUST be Traditional Chinese characters.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Place query in Traditional Chinese." },
          },
          required: ["query"],
        },
      },
      {
        name: "web_search",
        description:
          "Search the web for current events, news, prices, finance, weather, health facts. Optional category: 'health' | 'finance' | 'news' | 'shopping' picks a curated trusted-domain filter.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "What to look up on the web." },
            category: {
              type: "STRING",
              description: "Optional. health | finance | news | shopping",
            },
          },
          required: ["query"],
        },
      },
    ],
  },
];

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
    const r = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${anon}`,
      },
      body: JSON.stringify(body),
    });
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

async function callGemini(
  key: string,
  systemInstruction: string,
  contents: GeminiTurn[],
): Promise<{
  parts: GeminiPart[];
}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools: TOOLS,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 400,
      },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${t.slice(0, 500)}`);
  }
  const json = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return { parts };
}

export const generateAIResponse = createServerFn({ method: "POST" })
  .inputValidator((d: GenerateInput) => d)
  .handler(async ({ data }) => {
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
        return {
          text:
            text ||
            "唔好意思，頭先收音唔係幾好，可唔可以講多次？",
          history: contents,
          toolCalls,
        };
      }
      // Append the model's tool-calling turn, then run all tools in parallel
      // and append their responses as a single "function" turn.
      contents.push({ role: "model", parts });
      const responses = await Promise.all(
        fnCalls.map(async (p) => {
          const { name, args } = p.functionCall;
          const summary = await runTool(name, args);
          toolCalls.push({ name, args, summary });
          return {
            functionResponse: {
              name,
              response: { output: summary },
            },
          } as GeminiPart;
        }),
      );
      contents.push({ role: "function", parts: responses });
    }
    return {
      text: "（搵咗好多次都搵唔到答案，遲啲再試吓？）",
      history: contents,
      toolCalls,
    };
  });
