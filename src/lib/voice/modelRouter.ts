// Centralised model selection. Replaces hard-coded model strings scattered
// across llm.functions.ts, memory.functions.ts and session.functions.ts.
//
// Three roles:
//   - "main"     → conversational brain (gemini / qwen / grok), selected by
//                  the user in /instruction.
//   - "critic"   → hidden QA pass over the draft. Tries to use the same
//                  provider as main; falls back to Lovable AI Gateway when
//                  the selected provider's key is missing.
//   - "utility"  → non-conversational helpers (translation, summarisation).
//                  Always routed through Lovable AI Gateway.
import { readProvidersServerSide, type LlmProvider } from "./providerSettings.functions";

export type MainModel =
  | { provider: "gemini"; model: string; apiKey: string }
  | { provider: "qwen"; model: string; apiKey: string; apiUrl: string }
  | { provider: "grok"; model: string; apiKey: string; apiUrl: string };

// Centralised model ids — change in one place.
const MODEL_IDS = {
  gemini: "gemini-2.5-flash",
  qwen: "qwen-3.7-plus",
  grok: "grok-4-latest",
  utility: "google/gemini-2.5-flash", // Lovable AI Gateway model id
} as const;

// Custom Aliyun Model Studio workspace endpoint (OpenAI-compatible).
const QWEN_API_URL =
  "https://ws-gmzpr3q5gtcnhft1.ap-southeast-1.maas.aliyuncs.com/v1/chat/completions";

function getKey(provider: LlmProvider): string | undefined {
  if (provider === "gemini") return process.env.GEMINI_API_KEY;
  if (provider === "qwen") return process.env.DASHSCOPE_API_KEY;
  if (provider === "grok") return process.env.XAI_API_KEY;
  return undefined;
}

export async function resolveLlmModel(): Promise<MainModel> {
  const { llm } = await readProvidersServerSide();
  const key = getKey(llm);
  if (!key) throw new Error(`Missing API key for selected LLM provider '${llm}'.`);
  if (llm === "qwen") {
    return {
      provider: "qwen",
      model: MODEL_IDS.qwen,
      apiKey: key,
      apiUrl: QWEN_API_URL,
    };
  }
  if (llm === "grok") {
    return {
      provider: "grok",
      model: MODEL_IDS.grok,
      apiKey: key,
      apiUrl: "https://api.x.ai/v1/chat/completions",
    };
  }
  return { provider: "gemini", model: MODEL_IDS.gemini, apiKey: key };
}

// Critic prefers the same provider as main (respects user choice). Falls back
// to Lovable AI Gateway utility model if that provider lacks a key.
export type CriticCaller = (prompt: string) => Promise<string>;

export async function resolveCriticCaller(): Promise<CriticCaller | null> {
  const { llm } = await readProvidersServerSide();
  const key = getKey(llm);
  if (key) {
    if (llm === "gemini") return (p) => callGeminiSimple(key, MODEL_IDS.gemini, p);
    if (llm === "qwen")
      return (p) =>
        callOpenAISimple(
          QWEN_API_URL,
          MODEL_IDS.qwen,
          key,
          p,
        );
    if (llm === "grok")
      return (p) =>
        callOpenAISimple("https://api.x.ai/v1/chat/completions", MODEL_IDS.grok, key, p);
  }
  // Fallback: Lovable AI Gateway
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!lovableKey) return null;
  return (p) => callLovableGatewaySimple(lovableKey, MODEL_IDS.utility, p);
}

// Utility chat — used by translation / summarisation helpers. Always Lovable
// AI Gateway (no user-facing toggle for these background tasks).
// Utility chat — background helpers (memory summarisation, greeting generation,
// daily cache summarisation). Tries the configured LLM (Qwen/Grok) first for
// billing consolidation. Falls back to Lovable AI Gateway if: provider=gemini
// (direct blocked from HK), key missing, or the primary call fails.
// Returns { text, usedModel } so callers can log which model actually ran.
export async function callUtilityChat(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<{ text: string; usedModel: string }> {
  const { llm } = await readProvidersServerSide();
  const max = args.maxTokens ?? 400;

  // Try configured LLM if it's Qwen or Grok (not Gemini — direct call blocked from HK)
  if (llm === "qwen" || llm === "grok") {
    const key = getKey(llm);
    if (key) {
      try {
        const url =
          llm === "qwen"
            ? QWEN_API_URL
            : "https://api.x.ai/v1/chat/completions";
        const model = MODEL_IDS[llm];
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: args.system },
              { role: "user", content: args.user },
            ],
            max_tokens: max,
          }),
        });
        if (r.ok) {
          const j = (await r.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = j.choices?.[0]?.message?.content?.trim() ?? "";
          if (text) return { text, usedModel: llm };
        }
      } catch {
        // Fall through to Lovable gateway
      }
    }
  }

  // Fallback: Lovable AI Gateway (also primary path for provider=gemini)
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!lovableKey) throw new Error("Missing LOVABLE_API_KEY");
  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": lovableKey,
      Authorization: `Bearer ${lovableKey}`,
      "X-Lovable-AIG-SDK": "raw-fetch",
    },
    body: JSON.stringify({
      model: MODEL_IDS.utility,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      max_tokens: max,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Utility chat failed ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = j.choices?.[0]?.message?.content?.trim() ?? "";
  return { text, usedModel: "lovable-gateway/gemini-2.5-flash" };
}

// ---- low-level simple callers (no tools, single turn) ----

async function callGeminiSimple(key: string, model: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
    }),
  });
  if (!r.ok) return "";
  const j = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

async function callOpenAISimple(
  apiUrl: string,
  model: string,
  key: string,
  prompt: string,
): Promise<string> {
  const r = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 200,
    }),
  });
  if (!r.ok) return "";
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callLovableGatewaySimple(
  key: string,
  model: string,
  prompt: string,
): Promise<string> {
  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      Authorization: `Bearer ${key}`,
      "X-Lovable-AIG-SDK": "raw-fetch",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    }),
  });
  if (!r.ok) return "";
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}
