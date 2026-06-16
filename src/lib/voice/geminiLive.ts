// Base64 helpers
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
  onAudio?: (pcm: Uint8Array) => void; // 24kHz mono 16-bit LE
  onTurnComplete?: () => void;
  onError?: (msg: string) => void;
  onClose?: () => void;
};

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private cbs: GeminiCallbacks;

  constructor(cbs: GeminiCallbacks) {
    this.cbs = cbs;
  }

  connect(apiKey: string, systemInstruction: string): Promise<void> {
    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
      encodeURIComponent(apiKey);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        const setup = {
          setup: {
            model: "models/gemini-live-2.5-flash-native-audio",
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: { parts: [{ text: systemInstruction }] },
          },
        };
        ws.send(JSON.stringify(setup));
        resolve();
      };

      ws.onmessage = async (ev) => {
        try {
          let text: string;
          if (typeof ev.data === "string") {
            text = ev.data;
          } else if (ev.data instanceof Blob) {
            text = await ev.data.text();
          } else if (ev.data instanceof ArrayBuffer) {
            text = new TextDecoder().decode(ev.data);
          } else {
            return;
          }
          const msg = JSON.parse(text);
          this.handle(msg);
        } catch (err) {
          this.cbs.onError?.(String(err));
        }
      };

      ws.onerror = () => {
        this.cbs.onError?.("WebSocket error (check Gemini key & network)");
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

  private handle(msg: any) {
    if (msg.setupComplete) {
      this.cbs.onSetupComplete?.();
      return;
    }
    if (msg.serverContent) {
      const sc = msg.serverContent;
      const parts = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        const inline = p.inlineData;
        if (inline?.data && (inline.mimeType ?? "").startsWith("audio/")) {
          this.cbs.onAudio?.(base64ToBytes(inline.data));
        }
      }
      if (sc.turnComplete || sc.interrupted) {
        this.cbs.onTurnComplete?.();
      }
    }
    if (msg.error) {
      this.cbs.onError?.(msg.error.message ?? "Gemini error");
    }
  }

  sendAudioChunk(pcm: ArrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = bytesToBase64(new Uint8Array(pcm));
    const payload = {
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data }],
      },
    };
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}
