// Gemini Live native-audio client. Speaks to Google's BidiGenerateContent
// WebSocket directly from the browser using a key fetched from our server.
//
// Audio in:  PCM16 mono 16 kHz (same format the AudioEngine mic worklet emits)
// Audio out: PCM16 mono 24 kHz (same format AudioEngine.enqueuePcm expects)
//
// Supports: system instructions, voice config, input + output transcripts,
// barge-in / interruption, and function calling (web_search + search_places)
// using the same Supabase Edge Functions as the Qwen client.

import { supabase } from "@/integrations/supabase/client";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type GeminiCallbacks = {
  onSetupComplete?: () => void;
  onAudio?: (pcm: Uint8Array) => void;
  onTurnComplete?: () => void;
  onSpeechStarted?: () => void;
  onToolCall?: (info: { name: string; args: unknown; callId: string }) => void;
  onToolResult?: (info: { name: string; summary: string; callId: string }) => void;
  onError?: (msg: string) => void;
  onClose?: () => void;
  onAssistantTranscriptDelta?: (text: string) => void;
  onAssistantTranscriptDone?: (text: string) => void;
  onUserTranscript?: (text: string) => void;
  onDebug?: (msg: string) => void;
  onFlushPlayback?: () => void;
};

export type GeminiOptions = {
  voice?: string; // male: "Charon" | "Puck" | "Fenrir" | "Orus"
  model?: string;
  instructions: string;
};

const GEMINI_TOOLS = [
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
          "Search the web for current events, news, prices, finance, weather, health facts, and jokes.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "What to look up on the web." },
          },
          required: ["query"],
        },
      },
    ],
  },
];

async function runGeminiTool(name: string, args: unknown): Promise<string> {
  const query =
    typeof args === "object" && args && "query" in args
      ? String((args as Record<string, unknown>).query ?? "")
      : "";
  if (!query) return `Error: missing 'query' for ${name}.`;
  const fn = name === "search_places"
    ? "search-places"
    : name === "web_search"
      ? "web-search"
      : null;
  if (!fn) return `Error: unknown tool '${name}'.`;
  try {
    const { data, error } = await supabase.functions.invoke(fn, { body: { query } });
    if (error) return `Tool ${name} error: ${error.message}`;
    return (data as { summary?: string; error?: string } | null)?.summary
      ?? (data as { error?: string } | null)?.error
      ?? "No results.";
  } catch (e) {
    return `Tool ${name} threw: ${(e as Error).message}`;
  }
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private cbs: GeminiCallbacks;
  private intentionallyClosed = false;
  private handledToolCalls = new Set<string>();

  constructor(cbs: GeminiCallbacks) {
    this.cbs = cbs;
  }

  async connect(apiKey: string, opts: GeminiOptions): Promise<void> {
    const model = opts.model ?? "models/gemini-2.5-flash-native-audio-latest";
    const voice = opts.voice ?? "Charon"; // male voice
    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
      encodeURIComponent(apiKey);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let opened = false;

      ws.onopen = () => {
        opened = true;
        const setup = {
          setup: {
            model,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voice },
                },
              },
            },
            systemInstruction: { parts: [{ text: opts.instructions }] },
            tools: GEMINI_TOOLS,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                silenceDurationMs: 800,
              },
            },
          },
        };
        ws.send(JSON.stringify(setup));
        resolve();
      };

      ws.onmessage = async (ev) => {
        try {
          const text =
            typeof ev.data === "string"
              ? ev.data
              : ev.data instanceof Blob
                ? await ev.data.text()
                : new TextDecoder().decode(ev.data as ArrayBuffer);
          const msg = JSON.parse(text);
          await this.handle(msg);
        } catch (err) {
          console.warn("[GeminiLive] parse error", err);
        }
      };

      ws.onerror = () => {
        if (!opened) reject(new Error("Gemini WebSocket error"));
      };

      ws.onclose = (ev) => {
        if (this.intentionallyClosed) {
          this.cbs.onClose?.();
          return;
        }
        if (ev.code !== 1000 && ev.code !== 1005) {
          this.cbs.onError?.(
            `Closed (${ev.code})${ev.reason ? ": " + ev.reason : ""}`,
          );
        }
        this.cbs.onClose?.();
      };
    });
  }

  private kickOpening() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Send a silent kick so the model produces the opening turn (the
    // system prompt tells it to greet + summarise context on turn 1).
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "(session start)" }] }],
          turnComplete: true,
        },
      }),
    );
  }

  private async handle(msg: Record<string, unknown>) {
    if (msg.setupComplete) {
      this.cbs.onDebug?.("🧠 gemini setupComplete");
      this.cbs.onSetupComplete?.();
      this.kickOpening();
      return;
    }

    const sc = msg.serverContent as
      | {
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          turnComplete?: boolean;
          interrupted?: boolean;
          generationComplete?: boolean;
        }
      | undefined;

    if (sc) {
      if (sc.interrupted) {
        this.cbs.onDebug?.("🛑 interrupted");
        this.cbs.onFlushPlayback?.();
        this.cbs.onSpeechStarted?.();
      }
      const parts = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        const d = p.inlineData;
        if (d?.data && (d.mimeType ?? "").startsWith("audio/")) {
          this.cbs.onAudio?.(base64ToBytes(d.data));
        }
      }
      if (sc.inputTranscription?.text) {
        this.cbs.onUserTranscript?.(sc.inputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        this.cbs.onAssistantTranscriptDelta?.(sc.outputTranscription.text);
      }
      if (sc.turnComplete || sc.generationComplete) {
        this.cbs.onTurnComplete?.();
        this.cbs.onDebug?.("✓ turnComplete");
      }
    }

    const tc = msg.toolCall as
      | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
      | undefined;
    if (tc?.functionCalls?.length) {
      this.cbs.onFlushPlayback?.();
      for (const call of tc.functionCalls) {
        const callId = String(call.id ?? `${call.name}-${Date.now()}`);
        const name = String(call.name ?? "");
        if (!name || this.handledToolCalls.has(callId)) continue;
        this.handledToolCalls.add(callId);
        const args = call.args ?? {};
        this.cbs.onToolCall?.({ name, args, callId });
        const summary = await runGeminiTool(name, args);
        this.cbs.onToolResult?.({ name, summary, callId });
        this.sendToolResponse(callId, name, summary);
      }
      return;
    }

    if (msg.error) {
      const err = msg.error as { message?: string };
      this.cbs.onError?.(err.message ?? JSON.stringify(msg.error));
    }
  }

  private sendToolResponse(id: string, name: string, output: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            { id, name, response: { output } },
          ],
        },
      }),
    );
  }

  sendAudioChunk(pcm: ArrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = bytesToBase64(new Uint8Array(pcm));
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data }],
        },
      }),
    );
  }

  close() {
    this.intentionallyClosed = true;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "User ended session");
      } else {
        this.ws?.close();
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
