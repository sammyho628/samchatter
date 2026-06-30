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
import { readProvidersServerSide, type LlmProvider, DEFAULT_GREETING_MODEL } from "./providerSettings.functions";

export type MainModel =
  | { provider: "gemini"; model: string; apiKey: string }
  | { provider: "qwen"; model: string; apiKey: string; apiUrl: string }
  | { provider: "grok"; model: string; apiKey: string; apiUrl: string }
  | { provider: "openrouter"; model: string; apiKey: string; apiUrl: string };

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

// OpenRouter — OpenAI-compatible chat completions endpoint.
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Grok synthesis model — fast, non-reasoning. Planner keeps grok-4-latest
// (reasoning helpful for tool selection). Synthesiser uses a lightweight
// model so the response arrives in 2-4 s rather than 40-120 s.
const GROK_SYNTH_MODEL = "grok-3-mini";

function getKey(provider: LlmProvider): string | undefined {
  if (provider === "gemini") return process.env.GEMINI_API_KEY;
  if (provider === "qwen") return process.env.DASHSCOPE_API_KEY;
  if (provider === "grok") return process.env.XAI_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
}

export async function resolveLlmModel(
  role: "planner" | "synth" = "planner",
): Promise<MainModel> {
  const { llm, openrouterModel, openrouterSynthModel } = await readProvidersServerSide();
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
  if (llm === "openrouter") {
    return {
      provider: "openrouter",
      // Synthesiser uses a separate non-reasoning model so it doesn't burn
      // 40-120 s on an internal thinking chain before emitting the first token.
      model: role === "synth" ? openrouterSynthModel : openrouterModel,
      apiKey: key,
      apiUrl: OPENROUTER_API_URL,
    };
  }
  return { provider: "gemini", model: MODEL_IDS.gemini, apiKey: key };
}

// Critic prefers the same provider as main (respects user choice). Falls back
// to Lovable AI Gateway utility model if that provider lacks a key.
export type CriticCaller = (prompt: string) => Promise<string>;

export async function resolveCriticCaller(): Promise<CriticCaller | null> {
  const { llm, openrouterModel } = await readProvidersServerSide();
  const key = getKey(llm);
  if (key) {
    if (llm === "gemini") return (p) => callGeminiSimple(key, MODEL_IDS.gemini, p);
    if (llm === "qwen")
      return (p) => callOpenAISimple(QWEN_API_URL, MODEL_IDS.qwen, key, p);
    if (llm === "grok")
      return (p) =>
        callOpenAISimple("https://api.x.ai/v1/chat/completions", MODEL_IDS.grok, key, p);
    if (llm === "openrouter")
      return (p) => callOpenAISimple(OPENROUTER_API_URL, openrouterModel, key, p);
  }
  // Fallback: Lovable AI Gateway
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!lovableKey) return null;
  return (p) => callLovableGatewaySimple(lovableKey, MODEL_IDS.utility, p);
}

// Utility chat — used by translation / summarisation helpers. Always Lovable
// AI Gateway (no user-facing toggle for these background tasks).
// Utility chat — background helpers (memory summarisation, greeting generation,
// daily cache summarisation). Tries the configured LLM first for billing
// consolidation. Falls back to Lovable AI Gateway if: provider=gemini (direct
// blocked from HK), key missing, or the primary call fails.
// Returns { text, usedModel } so callers can log which model actually ran.
export async function callUtilityChat(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<{ text: string; usedModel: string }> {
  const { llm, openrouterModel } = await readProvidersServerSide();
  const max = args.maxTokens ?? 400;

  // Try configured LLM if it has a direct OpenAI-compatible endpoint
  // (Qwen, Grok, OpenRouter). Gemini direct is blocked from HK so we skip it.
  if (llm === "qwen" || llm === "grok" || llm === "openrouter") {
    const key = getKey(llm);
    if (key) {
      try {
        const url =
          llm === "qwen"
            ? QWEN_API_URL
            : llm === "grok"
              ? "https://api.x.ai/v1/chat/completions"
              : OPENROUTER_API_URL;
        const model =
          llm === "openrouter" ? openrouterModel : MODEL_IDS[llm];
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
          if (text)
            return {
              text,
              usedModel: llm === "openrouter" ? `openrouter:${model}` : llm,
            };
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

// Greeting-specific chat — uses the user-configured greeting model via OpenRouter.
// All greeting model options are OpenRouter models, so this always routes via
// OPENROUTER_API_KEY regardless of the main LLM provider setting.
// Falls back to callUtilityChat (Lovable Gateway) if OPENROUTER_API_KEY is absent.
export async function callGreetingChat(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<{ text: string; usedModel: string }> {
  const { greetingModel } = await readProvidersServerSide();
  const key = process.env.OPENROUTER_API_KEY;
  const model = greetingModel ?? DEFAULT_GREETING_MODEL;

  if (key) {
    try {
      const r = await fetch(OPENROUTER_API_URL, {
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
          max_tokens: args.maxTokens ?? 80,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = j.choices?.[0]?.message?.content?.trim() ?? "";
        if (text) return { text, usedModel: `openrouter:${model}` };
      }
    } catch {
      // Fall through to utility fallback
    }
  }

  // Fallback: callUtilityChat (Lovable Gateway or configured main LLM)
  return callUtilityChat(args);
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
