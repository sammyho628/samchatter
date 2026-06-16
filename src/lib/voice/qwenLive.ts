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
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const DEFAULT_TOOLS: QwenToolDef[] = [
  {
    type: "function",
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
  {
    type: "function",
    name: "web_search",
    description:
      "Search the internet for current events, news, or general factual knowledge.",
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
  private opts: QwenOptions | null = null;
  private intentionallyClosed = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;

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

      ws.onopen = () => {
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
              output_audio_format: "pcm16",
              tools: opts.tools ?? DEFAULT_TOOLS,
              tool_choice: "auto",
              turn_detection: {
                type: "semantic_vad",
                threshold: 0.5,
                silence_duration_ms: 800,
              },
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
        if (!this.intentionallyClosed) this.cbs.onError?.("Qwen WebSocket error");
        reject(new Error("WebSocket error"));
      };

      ws.onclose = (ev) => {
        if (!this.intentionallyClosed && ev.code === 1006 && this.scheduleReconnect()) {
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
      this.cbs.onAudio?.(base64ToBytes(msg.delta));
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.cbs.onSpeechStarted?.();
      return;
    }
    if (type === "error") {
      const err = msg.error as { message?: string } | undefined;
      this.cbs.onError?.(err?.message ?? JSON.stringify(msg.error ?? msg));
      return;
    }

    // Function call streaming — same shape as OpenAI Realtime.
    if (type === "response.function_call_arguments.delta") {
      const callId = String(msg.call_id ?? "");
      const name = String(msg.name ?? "");
      const delta = String(msg.delta ?? "");
      if (!callId) return;
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
      await this.runTool({ callId, name, argsStr });
      return;
    }

    // Some implementations emit the function_call inside response.output_item.done
    if (type === "response.output_item.done") {
      const item = msg.item as
        | { type?: string; name?: string; call_id?: string; arguments?: string }
        | undefined;
      if (item?.type === "function_call" && item.call_id && item.name) {
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
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
