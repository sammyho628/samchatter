// Qwen Realtime client — connects through our server proxy so the
// Authorization: Bearer header can be set server-side.

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

export type QwenCallbacks = {
  onSetupComplete?: () => void;
  onAudio?: (pcm: Uint8Array) => void; // 24kHz mono 16-bit LE
  onTurnComplete?: () => void;
  onSpeechStarted?: () => void;
  onError?: (msg: string) => void;
  onClose?: () => void;
};

export type QwenOptions = {
  voice?: string;
  model?: string;
  instructions: string;
};

export class QwenLiveClient {
  private ws: WebSocket | null = null;
  private cbs: QwenCallbacks;

  constructor(cbs: QwenCallbacks) {
    this.cbs = cbs;
  }

  connect(opts: QwenOptions): Promise<void> {
    const model = opts.model ?? "qwen3-omni-flash-realtime";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/public/qwen-proxy?model=${encodeURIComponent(model)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
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
          if (msg.type === "response.audio.delta" && msg.delta) {
            this.cbs.onAudio?.(base64ToBytes(msg.delta));
          } else if (msg.type === "response.done" || msg.type === "response.audio.done") {
            this.cbs.onTurnComplete?.();
          } else if (msg.type === "input_audio_buffer.speech_started") {
            this.cbs.onSpeechStarted?.();
          } else if (msg.type === "error") {
            this.cbs.onError?.(msg.error?.message ?? JSON.stringify(msg.error ?? msg));
          }
        } catch (err) {
          console.warn("[QwenLive] parse error", err);
        }
      };

      ws.onerror = () => {
        this.cbs.onError?.("Qwen WebSocket error");
        reject(new Error("WebSocket error"));
      };

      ws.onclose = (ev) => {
        if (ev.code !== 1000 && ev.code !== 1005) {
          this.cbs.onError?.(
            `Closed (${ev.code})${ev.reason ? ": " + ev.reason : ""}`,
          );
        }
        this.cbs.onClose?.();
      };
    });
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
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}
