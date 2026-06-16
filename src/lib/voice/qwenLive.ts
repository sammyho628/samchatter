// Qwen Realtime client — connects through our server proxy so the
// Authorization: Bearer header can be set server-side.
// Supports function/tool calling.
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

export type QwenToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const DEFAULT_TOOLS: QwenToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_places",
      description:
        "Search for real restaurants, businesses, or locations in Hong Kong. Returns name, address and rating of top results.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language place search query, e.g. 'dim sum in Sham Shui Po'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the internet for current events, finance, Yahoo Finance, stock market, current events, news, weather, prices, sports scores, or recently changing facts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look up on the web.",
          },
        },
        required: ["query"],
      },
    },
  },
];

export type QwenCallbacks = {
  onSetupComplete?: () => void;
  onAudio?: (pcm: Uint8Array) => void;
  onTurnComplete?: () => void;
  onSpeechStarted?: () => void;
  onToolCall?: (info: { name: string; args: unknown; callId: string }) => void;
  onToolResult?: (info: { name: string; summary: string; callId: string }) => void;
  onError?: (msg: string) => void;
  onReconnecting?: () => void;
  onClose?: () => void;
  // Streaming text — assistant audio transcript (what the AI is saying).
  onAssistantTranscriptDelta?: (text: string) => void;
  onAssistantTranscriptDone?: (text: string) => void;
  // Final user transcript from server-side ASR.
  onUserTranscript?: (text: string) => void;
  // Arbitrary debug event.
  onDebug?: (msg: string) => void;
  // Ask the UI to flush any queued/playing audio immediately (e.g. tool call).
  onFlushPlayback?: () => void;
};

export type QwenOptions = {
  voice?: string;
  model?: string;
  instructions: string;
  tools?: QwenToolDef[];
};

// Default handler: routes Qwen function calls to the matching Supabase Edge Function.
export async function executeQwenTool(
  name: string,
  args: unknown,
): Promise<string> {
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
    const { data, error } = await supabase.functions.invoke(fn, {
      body: { query },
    });
    if (error) return `Tool ${name} error: ${error.message}`;
    const summary = (data as { summary?: string; error?: string } | null)?.summary
      ?? (data as { error?: string } | null)?.error
      ?? "No results.";
    return summary;
  } catch (e) {
    return `Tool ${name} threw: ${(e as Error).message}`;
  }
}

export class QwenLiveClient {
  private ws: WebSocket | null = null;
  private cbs: QwenCallbacks;
  // Accumulate streamed function-call arguments by call_id.
  private pendingCalls = new Map<string, { name: string; args: string }>();
  private handledToolCalls = new Set<string>();
  private recentToolSignatures = new Map<string, number>();
  private opts: QwenOptions | null = null;
  private intentionallyClosed = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  // True from the moment we see a function_call streaming until we've sent
  // back the tool result. While true we drop any response.audio.delta so the
  // model's pre-tool partial sentence never reaches the speaker.
  private toolInProgress = false;

  constructor(cbs: QwenCallbacks) {
    this.cbs = cbs;
  }

  connect(opts: QwenOptions): Promise<void> {
    this.opts = opts;
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    return this.openSocket(opts);
  }

  private openSocket(opts: QwenOptions): Promise<void> {
    const model = opts.model ?? "qwen3.5-omni-flash-realtime";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/public/qwen-proxy?model=${encodeURIComponent(model)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.reconnectAttempts = 0;
        ws.send(
          JSON.stringify({
            event_id: `evt_${Date.now()}`,
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              voice: opts.voice ?? "Rocky",
              instructions: opts.instructions,
              input_audio_format: "pcm16",
              output_audio_format: "pcm",
              input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
              tools: opts.tools ?? DEFAULT_TOOLS,
              tool_choice: "auto",
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                silence_duration_ms: 800,
              },
              temperature: 0.6,
              repetition_penalty: 1.15,
              presence_penalty: 0.3,
            },
          }),
        );
        this.cbs.onSetupComplete?.();
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
          await this.handleMessage(msg);
        } catch (err) {
          console.warn("[QwenLive] parse error", err);
        }
      };

      ws.onerror = () => {
        if (!opened) reject(new Error("WebSocket error"));
      };

      ws.onclose = (ev) => {
        if (this.intentionallyClosed) {
          // User-initiated stop — silent regardless of code (including 1006).
          this.cbs.onClose?.();
          return;
        }
        if (ev.code === 1006 && this.scheduleReconnect()) {
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

  private scheduleReconnect() {
    if (!this.opts || this.reconnectAttempts >= 3 || this.reconnectTimer !== null) {
      return false;
    }
    this.reconnectAttempts += 1;
    this.cbs.onReconnecting?.();
    const delay = 350 * this.reconnectAttempts;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionallyClosed || !this.opts) return;
      void this.openSocket(this.opts).catch((err) => {
        if (!this.intentionallyClosed) {
          this.cbs.onError?.(`Reconnect failed: ${(err as Error).message}`);
        }
      });
    }, delay);
    return true;
  }

  private async handleMessage(msg: Record<string, unknown>) {
    const type = msg.type as string | undefined;
    if (!type) return;

    if (type === "response.audio.delta" && typeof msg.delta === "string") {
      if (this.toolInProgress) {
        // Drop any audio the model produced before / during tool execution —
        // it's a half-spoken sentence that will be repeated after the tool
        // result comes back.
        return;
      }
      this.cbs.onAudio?.(base64ToBytes(msg.delta));
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.cbs.onSpeechStarted?.();
      this.cbs.onDebug?.("🎤 speech_started");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.cbs.onDebug?.("🎤 speech_stopped");
      return;
    }
    if (type === "input_audio_buffer.committed") {
      this.cbs.onDebug?.("🎤 audio committed → model");
      return;
    }
    // Assistant audio transcript (streamed text of what AI says).
    if (type === "response.audio_transcript.delta" && typeof msg.delta === "string") {
      this.cbs.onAssistantTranscriptDelta?.(msg.delta);
      return;
    }
    if (type === "response.audio_transcript.done") {
      const t = typeof msg.transcript === "string" ? msg.transcript : "";
      if (t) this.cbs.onAssistantTranscriptDone?.(t);
      return;
    }
    // User transcript completed (server-side ASR).
    if (type === "conversation.item.input_audio_transcription.completed") {
      const t = typeof msg.transcript === "string" ? msg.transcript : "";
      if (t) this.cbs.onUserTranscript?.(t);
      return;
    }
    if (type === "response.created") {
      this.cbs.onDebug?.("🧠 response.created");
      // Kill switch — flush any leftover audio from a previous turn so the
      // new reply never overlaps the tail of the old one.
      try { this.cbs.onFlushPlayback?.(); } catch {}
      return;
    }
    if (type === "error") {
      const err = msg.error as { message?: string } | undefined;
      const m = err?.message ?? JSON.stringify(msg.error ?? msg);
      this.cbs.onError?.(m);
      this.cbs.onDebug?.(`❌ error: ${m}`);
      return;
    }

    // Function call streaming — same shape as OpenAI Realtime.
    if (type === "response.function_call_arguments.delta") {
      const callId = String(msg.call_id ?? "");
      const name = String(msg.name ?? "");
      const delta = String(msg.delta ?? "");
      if (!callId) return;
      this.beginToolSuppression();
      const cur = this.pendingCalls.get(callId) ?? { name, args: "" };
      cur.name = cur.name || name;
      cur.args += delta;
      this.pendingCalls.set(callId, cur);
      return;
    }

    if (type === "response.function_call_arguments.done") {
      const callId = String(msg.call_id ?? "");
      const name = String(msg.name ?? this.pendingCalls.get(callId)?.name ?? "");
      const argsStr = String(msg.arguments ?? this.pendingCalls.get(callId)?.args ?? "");
      this.pendingCalls.delete(callId);
      this.beginToolSuppression();
      await this.runTool({ callId, name, argsStr });
      return;
    }

    if (type === "response.output_item.done") {
      const item = msg.item as
        | { type?: string; name?: string; call_id?: string; arguments?: string }
        | undefined;
      if (item?.type === "function_call" && item.call_id && item.name) {
        this.beginToolSuppression();
        await this.runTool({
          callId: item.call_id,
          name: item.name,
          argsStr: item.arguments ?? "{}",
        });
      }
      return;
    }

    if (type === "response.done" || type === "response.audio.done") {
      this.cbs.onTurnComplete?.();
      this.cbs.onDebug?.(`✓ ${type}`);
      return;
    }
  }

  private async runTool({
    callId,
    name,
    argsStr,
  }: {
    callId: string;
    name: string;
    argsStr: string;
  }) {
    if (this.handledToolCalls.has(callId)) return;
    this.handledToolCalls.add(callId);
    const signature = `${name}:${argsStr}`;
    const now = Date.now();
    for (const [key, at] of this.recentToolSignatures) {
      if (now - at > 10_000) this.recentToolSignatures.delete(key);
    }
    if (this.recentToolSignatures.has(signature)) return;
    this.recentToolSignatures.set(signature, now);
    let parsed: unknown = {};
    try {
      parsed = argsStr ? JSON.parse(argsStr) : {};
    } catch {
      parsed = {};
    }
    this.cbs.onToolCall?.({ name, args: parsed, callId });

    const summary = await executeQwenTool(name, parsed);
    this.cbs.onToolResult?.({ name, summary, callId });
    this.sendToolResult(callId, summary);
  }

  private beginToolSuppression() {
    if (this.toolInProgress) return;
    this.toolInProgress = true;
    this.cbs.onDebug?.("🔧 tool call → flushing pre-tool audio");
    try {
      this.cbs.onFlushPlayback?.();
    } catch (e) {
      console.warn("[QwenLive] flush callback threw", e);
    }
  }

  private sendToolResult(callId: string, output: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        event_id: `evt_tool_${Date.now()}`,
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      }),
    );
    // Tool result has been fed back — allow the post-tool reply audio through.
    this.toolInProgress = false;
    // Ask the model to continue with the tool result.
    this.ws.send(
      JSON.stringify({
        event_id: `evt_resp_${Date.now()}`,
        type: "response.create",
      }),
    );
  }

  sendAudioChunk(pcm: ArrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const audio = bytesToBase64(new Uint8Array(pcm));
    this.ws.send(
      JSON.stringify({
        event_id: `evt_audio_${Date.now()}`,
        type: "input_audio_buffer.append",
        audio,
      }),
    );
  }

  close() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
