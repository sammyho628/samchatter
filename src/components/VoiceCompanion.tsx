import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { WaveformOrb } from "./WaveformOrb";
import { buildSystemPrompt } from "@/lib/voice/systemPrompt";
import { QwenLiveClient } from "@/lib/voice/qwenLive";
import { AudioEngine } from "@/lib/voice/audioEngine";
import { getVoiceSession } from "@/lib/voice/session.functions";

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

  const engineRef = useRef<AudioEngine | null>(null);
  const clientRef = useRef<QwenLiveClient | null>(null);
  const activeRef = useRef(false);

  const fetchSession = useServerFn(getVoiceSession);

  const stopAll = useCallback(async () => {
    activeRef.current = false;
    clientRef.current?.close();
    clientRef.current = null;
    await engineRef.current?.stop();
    engineRef.current = null;
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
    });
    engine.unlock();
    engineRef.current = engine;
    activeRef.current = true;
    setStatus("connecting");
    setErrorMsg("");

    void (async () => {
      try {
        const { contextText } = await fetchSession();
        const prompt = buildSystemPrompt(contextText);

        const client = new QwenLiveClient({
          onSetupComplete: async () => {
            try {
              await engine.startMic();
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
          onError: (msg: string) => {
            console.error("[QwenLive] error:", msg);
            setErrorMsg(msg);
            setStatus("error");
            activeRef.current = false;
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
      </div>
    </div>
  );
}
