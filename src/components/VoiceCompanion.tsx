import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { WaveformOrb } from "./WaveformOrb";
import { buildSystemPrompt } from "@/lib/voice/systemPrompt";
import { getVoiceSession } from "@/lib/voice/session.functions";
import { summarizeAndSaveSession } from "@/lib/voice/memory.functions";
import {
  getTodayChatTurns,
  appendChatTurn,
} from "@/lib/voice/chatTurns.functions";
import { transcribeAudio } from "@/lib/voice/pipeline/stt.functions";
import {
  generateAIResponse,
  type GeminiTurn,
} from "@/lib/voice/pipeline/llm.functions";
import { synthesizeSpeech } from "@/lib/voice/pipeline/tts.functions";
import { runTurn } from "@/lib/voice/pipeline/orchestrator";
import {
  startRecording,
  blobToBase64,
  type RecorderHandle,
} from "@/lib/voice/pipeline/recorder";
import {
  playBase64Audio,
  replayLast,
  stopPlayback,
  unlockAudio,
  hasLastBuffer,
} from "@/lib/voice/pipeline/player";
import { APP_VERSION } from "@/lib/version";

type Status =
  | "idle"
  | "listening" // mic open, user holding button
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "撳掣開始",
  listening: "🎤 聽緊…撳掣停止",
  transcribing: "辨認緊…",
  thinking: "諗緊…",
  speaking: "我講緊…",
  error: "出咗啲問題",
};

export function VoiceCompanion() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [debugOpen, setDebugOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [, forceRepaint] = useState(0);
  const [debugLog, setDebugLog] = useState<
    Array<{ t: number; kind: "user" | "ai" | "tool" | "evt" | "err"; text: string }>
  >([]);

  const pushLog = useCallback(
    (kind: "user" | "ai" | "tool" | "evt" | "err", text: string) => {
      setDebugLog((prev) => {
        const next = [...prev, { t: Date.now(), kind, text }];
        return next.length > 120 ? next.slice(next.length - 120) : next;
      });
    },
    [],
  );

  const recorderRef = useRef<RecorderHandle | null>(null);
  const historyRef = useRef<GeminiTurn[]>([]);
  const promptRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");
  const transcriptLinesRef = useRef<string[]>([]);
  const executedSearchesRef = useRef<string[]>([]);
  const promptLoadedRef = useRef(false);
  const promptLoadingRef = useRef(false);

  const fetchSession = useServerFn(getVoiceSession);
  const saveMemory = useServerFn(summarizeAndSaveSession);
  const loadTurns = useServerFn(getTodayChatTurns);
  const saveTurn = useServerFn(appendChatTurn);
  const sttFn = useServerFn(transcribeAudio);
  const llmFn = useServerFn(generateAIResponse);
  const ttsFn = useServerFn(synthesizeSpeech);

  // Fire-and-forget background save. Never blocks UI / LLM / TTS.
  const persistTurn = useCallback(
    (role: "user" | "model", text: string) => {
      if (!text.trim()) return;
      void saveTurn({ data: { role, text } }).catch((err) => {
        pushLog("err", `persist ${role}: ${(err as Error).message}`);
      });
    },
    [saveTurn, pushLog],
  );

  // Hydrate local chatContext from today's persisted turns (read once).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { date, turns } = await loadTurns();
        if (cancelled) return;
        historyRef.current = turns.map<GeminiTurn>((t) => ({
          role: t.role,
          parts: [{ text: t.text }],
        }));
        pushLog(
          "evt",
          `💾 hydrated ${turns.length} turn(s) from ${date}`,
        );
      } catch (err) {
        pushLog("err", `hydrate turns: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTurns, pushLog]);

  const loadPromptIfNeeded = useCallback(async () => {
    if (promptLoadedRef.current || promptLoadingRef.current) return;
    promptLoadingRef.current = true;
    try {
      const session = await fetchSession();
      const nowHK = new Date().toLocaleString("en-GB", {
        timeZone: "Asia/Hong_Kong",
        hour12: false,
      });
      const prompt = buildSystemPrompt(
        session.promptTemplate,
        session.contextText,
        nowHK,
        session.prefetchContext,
        session.memoryContext,
      );
      promptRef.current = prompt;
      promptLoadedRef.current = true;
      sessionIdRef.current = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      pushLog("evt", `🕒 HK now: ${nowHK}`);
      pushLog(
        "evt",
        `📚 ctx: ${session.contextText.length} · prefetch: ${session.prefetchContext.length} · memory: ${session.memoryContext.length}`,
      );
      pushLog("evt", `📝 FULL PROMPT (${prompt.length} chars) ↓↓↓`);
      const CHUNK = 1500;
      for (let i = 0; i < prompt.length; i += CHUNK) {
        pushLog("evt", prompt.slice(i, i + CHUNK));
      }
      pushLog("evt", `📝 END PROMPT`);
      try {
        console.log("[VoiceCompanion] FULL SYSTEM PROMPT →\n" + prompt);
      } catch {
        /* ignore */
      }
    } catch (err) {
      pushLog("err", `Session load failed: ${(err as Error).message}`);
    } finally {
      promptLoadingRef.current = false;
    }
  }, [fetchSession, pushLog]);

  const flushSessionSummary = useCallback(async () => {
    const lines = transcriptLinesRef.current;
    const sid = sessionIdRef.current;
    const searches = executedSearchesRef.current;
    transcriptLinesRef.current = [];
    executedSearchesRef.current = [];
    if (!sid || lines.length < 2) return;
    try {
      await saveMemory({
        data: {
          sessionId: sid,
          transcript: lines.join("\n").slice(0, 60000),
          executedSearches: searches,
        },
      });
    } catch {
      /* silent */
    }
  }, [saveMemory]);

  useEffect(() => {
    return () => {
      stopPlayback();
      recorderRef.current?.cancel();
      void flushSessionSummary();
    };
  }, [flushSessionSummary]);

  // ---- Push-to-talk lifecycle ----
  const startTalking = useCallback(async () => {
    if (
      status === "listening" ||
      status === "transcribing" ||
      status === "thinking"
    ) {
      return;
    }
    // Tapping during AI speech = barge-in stop.
    if (status === "speaking") {
      stopPlayback();
      setStatus("idle");
      return;
    }
    setErrorMsg("");
    try {
      await unlockAudio();
      await loadPromptIfNeeded();
      const handle = await startRecording();
      recorderRef.current = handle;
      setStatus("listening");
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus("error");
      pushLog("err", `mic: ${(err as Error).message}`);
    }
  }, [status, loadPromptIfNeeded, pushLog]);

  const stopTalkingAndSend = useCallback(async () => {
    const handle = recorderRef.current;
    if (!handle || status !== "listening") return;
    recorderRef.current = null;
    let blob: Blob;
    let mimeType: string;
    try {
      const r = await handle.stop();
      blob = r.blob;
      mimeType = r.mimeType;
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus("error");
      return;
    }
    if (blob.size < 1024) {
      pushLog("evt", `recording too short (${blob.size}B) — ignored`);
      setStatus("idle");
      return;
    }
    const audioBase64 = await blobToBase64(blob);
    pushLog("evt", `recorded ${blob.size}B (${mimeType})`);

    await runTurn(
      {
        audioBase64,
        mimeType,
        systemInstruction: promptRef.current,
        history: historyRef.current,
      },
      {
        transcribe: sttFn,
        generate: llmFn,
        synthesize: ttsFn,
        playAudio: async (b64, onEnded) => {
          await playBase64Audio(b64, onEnded);
          forceRepaint((n) => n + 1); // refresh replay button visibility
        },
      },
      {
        onTranscribing: () => setStatus("transcribing"),
        onTranscript: (t) => {
          pushLog("user", t);
          transcriptLinesRef.current.push(`USER: ${t}`);
          persistTurn("user", t);
        },
        onThinking: () => {
          setStatus("thinking");
          setSearching(false);
        },
        onToolCall: (t) => {
          setSearching(true);
          pushLog(
            "tool",
            `${t.name}(${JSON.stringify(t.args)}) → ${t.summary.length > 200 ? t.summary.slice(0, 200) + "…" : t.summary}`,
          );
          const q = t.args.query;
          if (typeof q === "string") {
            executedSearchesRef.current.push(`${t.name}: ${q}`);
          }
        },
        onAssistantText: (t) => {
          pushLog("ai", t);
          transcriptLinesRef.current.push(`AI: ${t}`);
          persistTurn("model", t);
        },
        onSpeaking: () => {
          setSearching(false);
          setStatus("speaking");
        },
        onDone: () => {
          setStatus((s) => (s === "error" ? s : "idle"));
        },
        onError: (msg) => {
          pushLog("err", msg);
          setErrorMsg(msg);
          setStatus("error");
        },
      },
    ).then((result) => {
      if (result) historyRef.current = result.history;
    });
  }, [status, sttFn, llmFn, ttsFn, pushLog, persistTurn]);

  // Keyboard: hold Spacebar to talk (when no input is focused).
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && /^(input|textarea|select)$/i.test(el.tagName);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping()) return;
      e.preventDefault();
      void startTalking();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping()) return;
      e.preventDefault();
      void stopTalkingAndSend();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startTalking, stopTalkingAndSend]);

  const tint: "idle" | "listening" | "speaking" =
    status === "speaking"
      ? "speaking"
      : status === "listening"
        ? "listening"
        : "idle";
  const isActive = status === "listening" || status === "speaking";

  const buttonLabel =
    status === "listening"
      ? "放開\n發送"
      : status === "speaking"
        ? "點一下\n停止"
        : status === "transcribing" || status === "thinking"
          ? "處理緊…"
          : "按住\n講嘢";

  const buttonDisabled =
    status === "transcribing" || status === "thinking";

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-between overflow-hidden bg-[oklch(0.18_0.04_265)] px-6 py-8 text-white">
      <div className="flex w-full items-start justify-between">
        <div className="text-left">
          <div className="text-3xl font-black tracking-tight">傾偈</div>
          <div className="mt-1 text-sm text-white/60">
            Voice Companion · <span className="text-white/80">REST · Gemini 2.5 Flash</span>
          </div>
        </div>
      </div>

      <div className="relative flex w-full flex-1 items-center justify-center">
        <div className="relative aspect-square w-[80vw] max-w-[440px]">
          <WaveformOrb getAnalyser={() => null} active={isActive} tint={tint} />
          <button
            type="button"
            disabled={buttonDisabled}
            onPointerDown={(e) => {
              e.preventDefault();
              void startTalking();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              void stopTalkingAndSend();
            }}
            onPointerCancel={() => {
              void stopTalkingAndSend();
            }}
            onPointerLeave={(e) => {
              if (e.buttons === 0) return;
              void stopTalkingAndSend();
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={[
              "absolute inset-[18%] select-none whitespace-pre-line rounded-full text-2xl font-black tracking-wide shadow-2xl transition-transform active:scale-95",
              status === "listening"
                ? "bg-gradient-to-br from-rose-400 to-orange-500 text-white"
                : status === "speaking"
                  ? "bg-gradient-to-br from-sky-400 to-indigo-500 text-white"
                  : buttonDisabled
                    ? "bg-white/10 text-white/40"
                    : "bg-gradient-to-br from-amber-300 to-orange-400 text-orange-950",
              status === "idle" ? "animate-vc-pulse" : "",
            ].join(" ")}
            style={{ touchAction: "none" }}
          >
            {buttonLabel}
          </button>
        </div>
      </div>

      <div className="w-full text-center">
        <div className="text-2xl font-bold">{STATUS_LABEL[status]}</div>
        {searching ? (
          <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-amber-300/40 bg-amber-400/15 px-3 py-1 text-sm text-amber-200">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-300" />
            🔍 搵緊資料… (Searching)
          </div>
        ) : null}
        {status === "error" && errorMsg ? (
          <div className="mt-2 text-base text-red-300/90 break-words">
            {errorMsg}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-center gap-3 text-xs text-white/40">
          <span>v{APP_VERSION}</span>
          <button
            type="button"
            onClick={() => setDebugOpen((v) => !v)}
            className="rounded-full border border-white/20 px-3 py-1 text-white/60 hover:bg-white/5"
          >
            {debugOpen ? "Hide debug" : "Show debug"} ({debugLog.length})
          </button>
          {hasLastBuffer() ? (
            <button
              type="button"
              onClick={() => replayLast(() => setStatus("idle"))}
              className="rounded-full border border-sky-300/40 bg-sky-400/10 px-3 py-1 text-sky-200 hover:bg-sky-400/20"
              title="Replay the last AI reply"
            >
              🔁 Replay
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              historyRef.current = [];
              pushLog("evt", "🧹 conversation history cleared");
            }}
            className="rounded-full border border-white/20 px-3 py-1 text-white/60 hover:bg-white/5"
          >
            Clear chat
          </button>
        </div>
      </div>

      {debugOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-50 max-h-[55vh] overflow-y-auto border-t border-white/10 bg-black/80 p-3 text-xs backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-mono text-white/70">Debug ({debugLog.length})</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDebugLog([])}
                className="rounded border border-white/20 px-2 py-0.5 text-white/70 hover:bg-white/10"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setDebugOpen(false)}
                className="rounded border border-white/20 px-2 py-0.5 text-white/70 hover:bg-white/10"
              >
                Close
              </button>
            </div>
          </div>
          {debugLog.length === 0 ? (
            <div className="text-white/40">No events yet. Press &amp; hold the button to speak.</div>
          ) : (
            <ul className="space-y-1 font-mono">
              {debugLog.map((e, i) => {
                const ts = new Date(e.t).toLocaleTimeString();
                const color =
                  e.kind === "user"
                    ? "text-emerald-300"
                    : e.kind === "ai"
                      ? "text-sky-300"
                      : e.kind === "tool"
                        ? "text-amber-300"
                        : e.kind === "err"
                          ? "text-rose-300"
                          : "text-white/50";
                const tag =
                  e.kind === "user"
                    ? "YOU"
                    : e.kind === "ai"
                      ? "AI "
                      : e.kind === "tool"
                        ? "TOOL"
                        : e.kind === "err"
                          ? "ERR"
                          : "evt";
                return (
                  <li key={i} className={`break-words ${color}`}>
                    <span className="text-white/30">{ts}</span>{" "}
                    <span className="text-white/40">{tag}</span> {e.text}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
