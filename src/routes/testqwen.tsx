import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Settings, Mic, Square } from "lucide-react";

export const Route = createFileRoute("/testqwen")({
  head: () => ({ meta: [{ title: "Voice Playground — Qwen / Gemini" }] }),
  component: TestQwenPage,
});

const SYSTEM_PROMPT =
  "You are a warm, patient, and friendly companion speaking to an elderly mother. You MUST speak exclusively in natural, casual Hong Kong Cantonese (口語). Do not use formal written Chinese.";

const LS_KEY = "voice-playground-settings-v1";

type Provider = "Qwen" | "Gemini";
type Settings = {
  dashscopeKey: string;
  geminiKey: string;
  provider: Provider;
};

const DEFAULTS: Settings = { dashscopeKey: "", geminiKey: "", provider: "Qwen" };

const PCM_WORKLET = `
class PCMCap extends AudioWorkletProcessor {
  constructor(){ super(); this._buf=new Float32Array(1600); this._w=0; }
  process(inputs){
    const ch = inputs[0]?.[0]; if(!ch) return true;
    for(let i=0;i<ch.length;i++){
      this._buf[this._w++]=ch[i];
      if(this._w>=this._buf.length){
        const pcm=new ArrayBuffer(this._buf.length*2);
        const dv=new DataView(pcm); let sumSq=0;
        for(let j=0;j<this._buf.length;j++){
          let s=this._buf[j]; if(s>1)s=1; else if(s<-1)s=-1;
          sumSq+=s*s;
          dv.setInt16(j*2, s<0?s*0x8000:s*0x7fff, true);
        }
        this.port.postMessage({pcm, rms:Math.sqrt(sumSq/this._buf.length)},[pcm]);
        this._w=0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-cap', PCMCap);
`;

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

type Status = "idle" | "connecting" | "listening" | "speaking" | "error";

function TestQwenPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  // refs for engine
  const wsRef = useRef<WebSocket | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playQueueRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartRef = useRef(0);
  const playingRef = useRef(false);
  const playbackGainRef = useRef<GainNode | null>(null);
  const activeRef = useRef(false);
  const providerRef = useRef<Provider>("Qwen");
  const playbackRateRef = useRef(24000);

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const saveSettings = (s: Settings) => {
    setSettings(s);
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  };

  const stopPlayback = () => {
    for (const src of playQueueRef.current) {
      try { src.onended = null; src.stop(); src.disconnect(); } catch {}
    }
    playQueueRef.current = [];
    nextStartRef.current = 0;
    playingRef.current = false;
  };

  const enqueuePcm = (pcm: Uint8Array) => {
    const ctx = playbackCtxRef.current;
    const gain = playbackGainRef.current;
    if (!ctx || !gain) return;
    const sampleCount = Math.floor(pcm.byteLength / 2);
    if (!sampleCount) return;
    const buf = ctx.createBuffer(1, sampleCount, playbackRateRef.current);
    const ch = buf.getChannelData(0);
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < sampleCount; i++) {
      const s = dv.getInt16(i * 2, true);
      ch[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const now = ctx.currentTime;
    const startAt = Math.max(now, nextStartRef.current);
    src.start(startAt);
    nextStartRef.current = startAt + buf.duration;
    playingRef.current = true;
    setStatus((s) => (s === "error" ? s : "speaking"));
    playQueueRef.current.push(src);
    src.onended = () => {
      const idx = playQueueRef.current.indexOf(src);
      if (idx >= 0) playQueueRef.current.splice(idx, 1);
      if (playQueueRef.current.length === 0) {
        playingRef.current = false;
        if (activeRef.current) setStatus((s) => (s === "error" ? s : "listening"));
      }
    };
  };

  const stopAll = async () => {
    activeRef.current = false;
    stopPlayback();
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    try { workletRef.current?.disconnect(); } catch {}
    workletRef.current = null;
    if (micStreamRef.current) {
      for (const t of micStreamRef.current.getTracks()) t.stop();
      micStreamRef.current = null;
    }
    try { await captureCtxRef.current?.close(); } catch {}
    try { await playbackCtxRef.current?.close(); } catch {}
    captureCtxRef.current = null;
    playbackCtxRef.current = null;
    playbackGainRef.current = null;
    setStatus("idle");
    setLevel(0);
  };

  const fail = (msg: string) => {
    setErrMsg(msg);
    setStatus("error");
    void stopAll();
  };

  const startQwen = async (_apiKey: string) => {
    // Connect through our server proxy so the Authorization: Bearer header
    // (which browsers cannot set on a WebSocket) can be added server-side.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/public/qwen-proxy?model=qwen3-omni-flash-realtime`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    playbackRateRef.current = 24000;


    ws.onopen = () => {
      console.log("[Qwen] ws.open — sending session.update");
      ws.send(JSON.stringify({
        event_id: `evt_${Date.now()}`,
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "Cherry",
          instructions: SYSTEM_PROMPT,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          turn_detection: {
            type: "semantic_vad",
            threshold: 0.5,
            silence_duration_ms: 800,
          },
        },
      }));
      setStatus("listening");
    };
    ws.onmessage = async (ev) => {
      try {
        const text = typeof ev.data === "string" ? ev.data
          : ev.data instanceof Blob ? await ev.data.text()
          : new TextDecoder().decode(ev.data);
        const msg = JSON.parse(text);
        // Log everything except audio bytes (too noisy)
        if (msg.type !== "response.audio.delta") {
          console.log("[Qwen] <-", msg.type, msg);
        }
        if (msg.type === "response.audio.delta" && msg.delta) {
          enqueuePcm(b64decode(msg.delta));
        } else if (msg.type === "input_audio_buffer.speech_started") {
          stopPlayback();
          setStatus((s) => (s === "error" ? s : "listening"));
        } else if (msg.type === "error") {
          fail(msg.error?.message ?? JSON.stringify(msg.error ?? msg));
        }
      } catch (e) {
        console.warn("[Qwen] parse error", e);
      }
    };
    ws.onerror = (e) => {
      console.error("[Qwen] ws.error", e);
      fail("Qwen WebSocket error (check console)");
    };
    ws.onclose = (ev) => {
      console.log("[Qwen] ws.close", ev.code, ev.reason);
      if (activeRef.current && ev.code !== 1000)
        fail(`Qwen closed (${ev.code}) ${ev.reason || ""}`);
    };
  };


  const startGemini = async (apiKey: string) => {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    playbackRateRef.current = 24000;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: "models/gemini-2.5-flash-native-audio-latest",
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        },
      }));
    };
    ws.onmessage = async (ev) => {
      try {
        const text = typeof ev.data === "string" ? ev.data
          : ev.data instanceof Blob ? await ev.data.text()
          : new TextDecoder().decode(ev.data);
        const msg = JSON.parse(text);
        if (msg.setupComplete) {
          setStatus("listening");
          return;
        }
        const parts = msg.serverContent?.modelTurn?.parts ?? [];
        for (const p of parts) {
          const inline = p.inlineData;
          if (inline?.data && (inline.mimeType ?? "").startsWith("audio/")) {
            enqueuePcm(b64decode(inline.data));
          }
        }
        if (msg.error) fail(msg.error.message ?? "Gemini error");
      } catch {}
    };
    ws.onerror = () => fail("Gemini WebSocket error");
    ws.onclose = (ev) => {
      if (activeRef.current && ev.code !== 1000 && ev.code !== 1005)
        fail(`Gemini closed (${ev.code}) ${ev.reason || ""}`);
    };
  };

  const sendMicChunk = (pcm: ArrayBuffer) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const audio = b64encode(new Uint8Array(pcm));
    if (providerRef.current === "Qwen") {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    } else {
      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: audio }],
        },
      }));
    }
  };

  const start = async () => {
    setErrMsg(null);
    const { provider, dashscopeKey, geminiKey } = settings;
    // Qwen uses the server-side proxy (no client key needed).
    // Gemini still needs the user's API key in the browser.
    const key = provider === "Qwen" ? (dashscopeKey || "proxy") : geminiKey;
    if (provider === "Gemini" && !key.trim()) {
      setShowSettings(true);
      setErrMsg(`Please add your Gemini API key in Settings.`);
      return;
    }

    providerRef.current = provider;
    activeRef.current = true;
    setStatus("connecting");

    try {
      // iOS unlock — synchronous in user gesture, no awaits before .resume()
      const AC: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      const cap = new AC({ sampleRate: 16000 });
      const play = new AC({ sampleRate: 24000 });
      void cap.resume();
      void play.resume();
      captureCtxRef.current = cap;
      playbackCtxRef.current = play;
      const gain = play.createGain();
      gain.connect(play.destination);
      playbackGainRef.current = gain;

      // mic
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;

      const blob = new Blob([PCM_WORKLET], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await cap.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const src = cap.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(cap, "pcm-cap");
      workletRef.current = node;
      node.port.onmessage = (ev) => {
        const { pcm, rms } = ev.data;
        setLevel(Math.min(1, rms * 4));
        sendMicChunk(pcm);
        // barge-in
        if (playingRef.current && rms > 0.05) {
          stopPlayback();
          if (activeRef.current) setStatus("listening");
        }
      };
      src.connect(node);

      if (provider === "Qwen") await startQwen(key);
      else await startGemini(key);
    } catch (err) {
      fail((err as Error).message || "Failed to start");
    }
  };

  const tint =
    status === "speaking" ? "from-amber-300 to-orange-500"
    : status === "listening" ? "from-cyan-300 to-blue-500"
    : status === "connecting" ? "from-violet-300 to-purple-500"
    : status === "error" ? "from-red-400 to-red-600"
    : "from-zinc-400 to-zinc-600";

  const isActive = status !== "idle" && status !== "error";

  return (
    <div className="min-h-[100dvh] bg-black text-white flex flex-col">
      <header className="flex items-center justify-between px-5 pt-6 pb-4">
        <div>
          <h1 className="text-xl font-black tracking-tight">Voice Playground</h1>
          <p className="text-xs text-white/50 mt-0.5">
            Provider: <span className="text-white/80 font-semibold">{settings.provider}</span>
          </p>
        </div>
        <button
          aria-label="Settings"
          onClick={() => setShowSettings(true)}
          className="rounded-full bg-white/10 p-3 active:bg-white/20"
        >
          <Settings className="size-5" />
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 gap-10">
        {/* Pulsing orb */}
        <div className="relative size-64 flex items-center justify-center">
          <div
            className={`absolute inset-0 rounded-full bg-gradient-to-br ${tint} blur-2xl opacity-60 transition-opacity`}
            style={{ transform: `scale(${1 + level * 0.4})` }}
          />
          <div
            className={`absolute inset-6 rounded-full bg-gradient-to-br ${tint} opacity-80 transition-transform`}
            style={{ transform: `scale(${1 + level * 0.25})` }}
          />
          <div
            className={`absolute inset-12 rounded-full bg-gradient-to-br ${tint} ${isActive ? "animate-pulse" : ""}`}
          />
          <div className="relative text-center">
            <div className="text-sm uppercase tracking-widest font-bold text-white/90">
              {status === "idle" ? "Ready" : status}
            </div>
          </div>
        </div>

        {errMsg && (
          <p className="text-sm text-red-400 text-center max-w-xs">{errMsg}</p>
        )}

        <button
          onClick={isActive ? stopAll : start}
          className={`w-full max-w-sm rounded-full py-6 text-2xl font-black tracking-tight shadow-2xl active:scale-[0.98] transition-transform ${
            isActive
              ? "bg-red-500 text-white"
              : "bg-white text-black"
          }`}
        >
          <span className="inline-flex items-center justify-center gap-3">
            {isActive ? <Square className="size-6" /> : <Mic className="size-7" />}
            {isActive ? "Stop" : "Start Conversation"}
          </span>
        </button>
      </main>

      <footer className="px-6 pb-8 text-center text-[11px] text-white/40">
        Speak naturally — the AI will respond in Cantonese.
      </footer>

      {showSettings && (
        <SettingsModal
          initial={settings}
          onClose={() => setShowSettings(false)}
          onSave={(s) => { saveSettings(s); setShowSettings(false); }}
        />
      )}
    </div>
  );
}

function SettingsModal({
  initial, onClose, onSave,
}: {
  initial: Settings;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  const [s, setS] = useState<Settings>(initial);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-md bg-zinc-900 text-white rounded-t-3xl sm:rounded-3xl p-6 border border-white/10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Settings</h2>
          <button onClick={onClose} className="text-white/60 text-sm">Close</button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-white/70 mb-1.5 block">
              AI Provider
            </label>
            <select
              value={s.provider}
              onChange={(e) => setS({ ...s, provider: e.target.value as Provider })}
              className="w-full bg-zinc-800 rounded-xl px-4 py-3 text-base outline-none focus:ring-2 ring-white/30"
            >
              <option value="Qwen">Qwen</option>
              <option value="Gemini">Gemini</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-white/70 mb-1.5 block">
              Alibaba DashScope API Key
            </label>
            <input
              type="password"
              autoComplete="off"
              value={s.dashscopeKey}
              onChange={(e) => setS({ ...s, dashscopeKey: e.target.value })}
              placeholder="sk-..."
              className="w-full bg-zinc-800 rounded-xl px-4 py-3 text-base outline-none focus:ring-2 ring-white/30"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-white/70 mb-1.5 block">
              Google Gemini API Key
            </label>
            <input
              type="password"
              autoComplete="off"
              value={s.geminiKey}
              onChange={(e) => setS({ ...s, geminiKey: e.target.value })}
              placeholder="AIza..."
              className="w-full bg-zinc-800 rounded-xl px-4 py-3 text-base outline-none focus:ring-2 ring-white/30"
            />
          </div>
        </div>
        <button
          onClick={() => onSave(s)}
          className="mt-6 w-full bg-white text-black font-bold rounded-full py-3.5 text-base"
        >
          Save
        </button>
        <p className="text-[11px] text-white/40 mt-3 text-center">
          Stored locally in your browser (localStorage).
        </p>
      </div>
    </div>
  );
}
