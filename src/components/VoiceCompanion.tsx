import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { WaveformOrb } from "./WaveformOrb";
import { buildSystemPrompt } from "@/lib/voice/systemPrompt";
import { QwenLiveClient } from "@/lib/voice/qwenLive";
import { AudioEngine } from "@/lib/voice/audioEngine";
import { getVoiceSession } from "@/lib/voice/session.functions";
import { APP_VERSION } from "@/lib/version";

type Status = "idle" | "connecting" | "listening" | "speaking" | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "撳一下開始傾偈",
  connecting: "連接緊…",
  listening: "我聽緊你講",
  speaking: "我講緊…",
  error: "出咗啲問題",
};

export function VoiceCompanion() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [muted, setMuted] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<
    Array<{ t: number; kind: "user" | "ai" | "tool" | "evt" | "err"; text: string }>
  >([]);
  const assistantBufRef = useRef<string>("");
  const pushLog = useCallback(
    (kind: "user" | "ai" | "tool" | "evt" | "err", text: string) => {
      setDebugLog((prev) => {
        const next = [...prev, { t: Date.now(), kind, text }];
        return next.length > 80 ? next.slice(next.length - 80) : next;
      });
    },
    [],
  );

  const engineRef = useRef<AudioEngine | null>(null);
  const clientRef = useRef<QwenLiveClient | null>(null);
  const activeRef = useRef(false);
  const micStartedRef = useRef(false);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      engineRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const toggleMicMute = useCallback(() => {
    setMicMuted((m) => {
      const next = !m;
      engineRef.current?.setMicMuted(next);
      return next;
    });
  }, []);

  const fetchSession = useServerFn(getVoiceSession);

  const stopAll = useCallback(async () => {
    activeRef.current = false;
    clientRef.current?.close();
    clientRef.current = null;
    await engineRef.current?.stop();
    engineRef.current = null;
    micStartedRef.current = false;
    setStatus("idle");
  }, []);

  useEffect(() => {
    return () => {
      void stopAll();
    };
  }, [stopAll]);

  const handleStart = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (activeRef.current) {
      void stopAll();
      return;
    }

    // CRITICAL — synchronous unlock inside the gesture for iOS Safari.
    const engine = new AudioEngine({
      onMicChunk: (pcm) => clientRef.current?.sendAudioChunk(pcm),
      onBargeIn: () => setStatus("listening"),
      onDebug: (m) => pushLog("evt", m),
    });
    engine.unlock();
    engine.setMuted(muted);
    engine.setMicMuted(micMuted);
    engineRef.current = engine;
    activeRef.current = true;
    setStatus("connecting");
    setErrorMsg("");
    setDebugLog([]);
    assistantBufRef.current = "";

    void (async () => {
      try {
        const { contextText, promptTemplate } = await fetchSession();
        const prompt = buildSystemPrompt(promptTemplate, contextText);


        const client = new QwenLiveClient({
          onSetupComplete: async () => {
            try {
              if (!micStartedRef.current) {
                await engine.startMic();
                micStartedRef.current = true;
              }
              setStatus("listening");
            } catch (err) {
              setErrorMsg(`Mic: ${(err as Error).message}`);
              setStatus("error");
              await stopAll();
            }
          },
          onAudio: (pcm: Uint8Array) => {
            engine.enqueuePcm(pcm);
            setStatus("speaking");
          },
          onSpeechStarted: () => {
            engine.stopPlayback();
            if (activeRef.current) setStatus("listening");
          },
          onTurnComplete: () => {
            if (activeRef.current) setStatus("listening");
          },
          onToolCall: ({ name, args }) => {
            console.log("[Qwen] tool call:", name, args);
            engine.stopPlayback();
            if (activeRef.current) setStatus("listening");
          },
          onToolResult: ({ name, summary }) => {
            console.log("[Qwen] tool_result <-", name, summary);
          },
          onError: (msg: string) => {
            console.error("[QwenLive] error:", msg);
            setErrorMsg(msg);
            setStatus("error");
            activeRef.current = false;
          },
          onReconnecting: () => {
            if (activeRef.current) setStatus("connecting");
          },
          onClose: () => {
            console.log("[QwenLive] closed");
            setStatus((s) => (s === "error" ? s : "idle"));
            activeRef.current = false;
          },
        });
        clientRef.current = client;
        await client.connect({ voice: "Rocky", instructions: prompt });
      } catch (err) {
        setErrorMsg((err as Error).message);
        setStatus("error");
        await stopAll();
      }
    })();
  };

  const tint: "idle" | "listening" | "speaking" =
    status === "speaking" ? "speaking" : status === "listening" ? "listening" : "idle";
  const isActive = status === "listening" || status === "speaking";

  const getAnalyser = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return null;
    if (status === "speaking") return eng.playbackAnalyser;
    if (status === "listening") return eng.micAnalyser;
    return null;
  }, [status]);

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-between overflow-hidden bg-[oklch(0.18_0.04_265)] px-6 py-8 text-white">
      <div className="flex w-full items-start justify-between">
        <div className="text-left">
          <div className="text-3xl font-black tracking-tight">傾偈</div>
          <div className="mt-1 text-sm text-white/60">Voice Companion</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMicMute}
            aria-pressed={micMuted}
            aria-label={micMuted ? "開啟咪高峰" : "關閉咪高峰"}
            title={micMuted ? "Mic muted" : "Mic on"}
            className={[
              "flex h-12 w-12 items-center justify-center rounded-full border transition-colors active:scale-95",
              micMuted
                ? "border-amber-400/60 bg-amber-500/20 text-amber-200"
                : "border-white/20 bg-white/5 text-white/80 hover:bg-white/10",
            ].join(" ")}
          >
            {micMuted ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
            )}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            aria-label={muted ? "解除靜音" : "靜音"}
            title={muted ? "Speaker muted" : "Speaker on"}
            className={[
              "flex h-12 w-12 items-center justify-center rounded-full border transition-colors active:scale-95",
              muted
                ? "border-rose-400/60 bg-rose-500/20 text-rose-200"
                : "border-white/20 bg-white/5 text-white/80 hover:bg-white/10",
            ].join(" ")}
          >
            {muted ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            )}
          </button>
        </div>
      </div>

      <div className="relative flex w-full flex-1 items-center justify-center">
        <div className="relative aspect-square w-[80vw] max-w-[440px]">
          <WaveformOrb getAnalyser={getAnalyser} active={isActive} tint={tint} />
          <button
            onClick={handleStart}
            className={[
              "absolute inset-[18%] rounded-full text-2xl font-black tracking-wide shadow-2xl transition-transform active:scale-95",
              isActive
                ? "bg-gradient-to-br from-rose-400 to-orange-500 text-white"
                : "bg-gradient-to-br from-amber-300 to-orange-400 text-orange-950",
              status === "idle" ? "animate-vc-pulse" : "",
            ].join(" ")}
          >
            {isActive ? "停止" : "開始\n傾偈"}
          </button>
        </div>
      </div>

      <div className="w-full text-center">
        <div className="text-2xl font-bold">{STATUS_LABEL[status]}</div>
        {status === "error" && errorMsg ? (
          <div className="mt-2 text-base text-red-300/90 break-words">
            {errorMsg}
          </div>
        ) : null}
        <div className="mt-3 text-xs text-white/30">v{APP_VERSION}</div>
      </div>
    </div>
  );
}
