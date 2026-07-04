import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { WaveformOrb } from "./WaveformOrb";
import { buildSystemPrompt } from "@/lib/voice/systemPrompt";
import { getVoiceSession } from "@/lib/voice/session.functions";
import { summarizeAndSaveSession, generateContextualGreeting } from "@/lib/voice/memory.functions";
import {
  getTodayChatTurns,
  appendChatTurn,
} from "@/lib/voice/chatTurns.functions";
import { transcribeAudio } from "@/lib/voice/pipeline/stt.functions";
import {
  planQueries,
  executeToolCall,
  synthesizeAnswer,
  type GeminiTurn,
} from "@/lib/voice/pipeline/llm.functions";
import { synthesizeSpeech } from "@/lib/voice/pipeline/tts.functions";
import { runTurn } from "@/lib/voice/pipeline/orchestrator";
import {
  startRecording,
  type RecorderHandle,
} from "@/lib/voice/pipeline/recorder";
import {
  playBase64Audio,
  replayLast,
  stopPlayback,
  startKeepAlive,
  stopKeepAlive,
  unlockAudio,
  hasLastBuffer,
  subscribeLastBuffer,
  subscribePlayerDiagnostics,
} from "@/lib/voice/pipeline/player";
import { APP_VERSION } from "@/lib/version";
import { getProviderSettings } from "@/lib/voice/providerSettings.functions";
import { classifyFillerIntent, pickFillerPhrase } from "@/lib/voice/pipeline/fillerIntent";

type Status =
  | "idle"
  | "listening"
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

const HISTORY_WINDOW = 20;

/** Keep only role=user|model turns whose parts are plain text — drop tool
 *  call / function-response turns so they don't leak back into future
 *  requests (causes Gemini 400s after hydration from DB). */
function sanitizeHistory(turns: GeminiTurn[]): GeminiTurn[] {
  return turns
    .filter((t) => t.role === "user" || t.role === "model")
    .map((t) => ({
      role: t.role,
      parts: t.parts.filter((p) => "text" in p && typeof p.text === "string"),
    }))
    .filter((t) => t.parts.length > 0);
}

/**
 * Fix 39: Compute a per-turn name-addressing token based on recent conversation history.
 * Suppresses name if used in the last 3 assistant (model) turns; permits it otherwise.
 */
function buildNameToken(history: GeminiTurn[]): string {
  const nameVariants = ["明女", "米米", "wendy", "Wendy"];
  const assistantTurns = history.filter((t) => t.role === "model").slice(-6);
  const last3 = assistantTurns.slice(-3);
  const usedRecently = last3.some((t) =>
    t.parts.some(
      (p) =>
        "text" in p &&
        typeof p.text === "string" &&
        nameVariants.some((n) => p.text!.includes(n)),
    ),
  );
  if (usedRecently) {
    return "\n\n[本 turn 稱呼令牌] 本次回應唔好叫佢名字，直接講話，更自然。";
  }
  return "\n\n[本 turn 稱呼令牌] 如果對話流暢嘅話，可以用佢名（明女、米米 或 Wendy）自然地叫佢一次；唔係必須，直接講話一樣可以。";
}




function getTimeGreeting(personaName: string): string {
  const hkHour = parseInt(
    new Date().toLocaleString("en-CA", {
      timeZone: "Asia/Hong_Kong",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
  const name = personaName && personaName !== "朋友" ? `，${personaName}` : "";

  if (hkHour >= 5 && hkHour < 12)
    return `早晨${name}！我喺度，撳個掣就可以同我傾偈。`;
  if (hkHour >= 12 && hkHour < 14)
    return `${name}，食咗飯未？有咩想問就問我啦。`;
  if (hkHour >= 14 && hkHour < 18)
    return `下午好${name}！有咩可以幫到你？`;
  if (hkHour >= 18 && hkHour < 21)
    return `夜晚喇${name}，有咩想傾？`;
  return `咁夜喇${name}，有咩事呀？`;
}


export function VoiceCompanion() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [debugOpen, setDebugOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasReplay, setHasReplay] = useState<boolean>(() => hasLastBuffer());
  const [showSplash, setShowSplash] = useState<boolean>(true);
  const [greeting, setGreeting] = useState<boolean>(false);
  const [providers, setProviders] = useState<{ llm: string; tts: string }>({
    llm: "gemini",
    tts: "google",
  });
  const [textInput, setTextInput] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const turnGenRef = useRef(0);
  const [debugLog, setDebugLog] = useState<
    Array<{ t: number; kind: "user" | "ai" | "tool" | "evt" | "err" | "db"; text: string }>
  >([]);

  const pushLog = useCallback(
    (kind: "user" | "ai" | "tool" | "evt" | "err" | "db", text: string) => {
      setDebugLog((prev) => {
        const next = [...prev, { t: Date.now(), kind, text }];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    },
    [],
  );

  // Reactive replay button.
  useEffect(() => subscribeLastBuffer(setHasReplay), []);

  // Surface AudioContext / autoplay failures in the in-app debug log so we
  // can tell when the browser is blocking sound after a hard refresh.
  useEffect(() => subscribePlayerDiagnostics((m) => pushLog("evt", m)), [pushLog]);

  // When the user switches back to the tab (iOS often suspends the
  // AudioContext while backgrounded), arm a one-shot unlock that fires on
  // the next pointer/touch gesture. This flushes a fresh AudioContext so
  // the speaker is never permanently muted after a long background.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      pushLog("evt", "[ui] visibilitychange → visible · arming silent unlock on next gesture");
      const armed = () => {
        window.removeEventListener("pointerdown", armed, true);
        window.removeEventListener("touchstart", armed, true);
        void unlockAudio().catch((err) =>
          pushLog("err", `rebond unlock: ${(err as Error).message}`),
        );
      };
      window.addEventListener("pointerdown", armed, { capture: true, passive: true, once: true });
      window.addEventListener("touchstart", armed, { capture: true, passive: true, once: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [pushLog]);


  const recorderRef = useRef<RecorderHandle | null>(null);
  const historyRef = useRef<GeminiTurn[]>([]);
  const promptRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");
  const transcriptLinesRef = useRef<string[]>([]);
  const executedSearchesRef = useRef<string[]>([]);
  const promptLoadedAtRef = useRef<number>(0);
  const promptLoadingRef = useRef(false);
  const personaNameRef = useRef<string>("朋友");
  const greetingAudioRef = useRef<string | null>(null);
  // showSplashRef mirrors showSplash state for async closures that can't
  // capture the latest state value (e.g. inside loadPromptIfNeeded).
  const showSplashRef = useRef<boolean>(true);
  // greetingPlayedRef prevents the late-delivery path from double-playing
  // if the pre-fetch audio arrives after handleSplashTap already played it.
  const greetingPlayedRef = useRef<boolean>(false);
  // Stores the in-flight Promise of the background greeting pre-fetch so
  // handleSplashTap can await it instead of re-running the full LLM pipeline.
  const greetingPrefetchRef = useRef<Promise<void> | null>(null);
  // Shot 1: instant "你好呀！" audio pre-fetched at mount. Plays immediately on tap
  // while the full personalized greeting loads in the background.
  const shot1AudioRef = useRef<string | null>(null);
  // Fix 48 — instant filler response. fillerDoneRef resolves once this turn's
  // filler audio (if any) has finished playing; the real answer's playback is
  // chained onto it so the two never overlap. fillerPlayedThisTurnRef tracks
  // whether a filler played this turn, so onError can speak an apology instead
  // of leaving dead silence after a "wait" promise.
  const fillerDoneRef = useRef<Promise<void>>(Promise.resolve());
  const fillerPlayedThisTurnRef = useRef(false);
  const turnCountRef = useRef(0);
  const lastMemorySaveRef = useRef(0);
  const sessionDataRef = useRef<{
    personaName: string;
    weatherSnippet: string;
    lastMemorySummary: string | null;
    daysSinceLastSession: number | null;
  } | null>(null);
  const PROMPT_TTL_MS = 30 * 60 * 1000; // 30 min — refetch knowledge/memory/daily cache


  const fetchSession = useServerFn(getVoiceSession);
  const saveMemory = useServerFn(summarizeAndSaveSession);
  const loadTurns = useServerFn(getTodayChatTurns);
  const saveTurn = useServerFn(appendChatTurn);
  const sttFn = useServerFn(transcribeAudio);
  const planFn = useServerFn(planQueries);
  const execToolFn = useServerFn(executeToolCall);
  const synthAnswerFn = useServerFn(synthesizeAnswer);
  const ttsFn = useServerFn(synthesizeSpeech);
  const fetchProviders = useServerFn(getProviderSettings);
  const genGreeting = useServerFn(generateContextualGreeting);


  // Load active provider settings so the header (and debug log) reflects
  // what the brain is actually using on the next turn.
  useEffect(() => {
    void fetchProviders()
      .then((p) => {
        setProviders(p);
        const utilityLabel =
          p.llm === "gemini"
            ? "lovable-gateway/gemini-2.5-flash"
            : `${p.llm}→lovable-gateway/gemini-2.5-flash(fallback)`;
        console.log(
          `[${new Date().toISOString()}] 🔧 models · planner=${p.llm} · synthesizer=${p.llm} · critic=${p.llm}→lovable-gateway · tts=${p.tts} · utility=${utilityLabel}`,
        );
        pushLog(
          "evt",
          `🔧 models · planner=${p.llm} · synthesizer=${p.llm} · critic=${p.llm}→lovable-gateway · tts=${p.tts} · utility=${utilityLabel}`,
        );
      })
      .catch(() => {});
  }, [fetchProviders, pushLog]);

  const persistTurn = useCallback(
    (role: "user" | "model", text: string) => {
      if (!text.trim()) return;
      pushLog("db", `→ write ${role} (${text.length} chars)`);
      void saveTurn({ data: { role, text } })
        .then(() => pushLog("db", `✓ wrote ${role}`))
        .catch((err) => {
          pushLog("err", `persist ${role}: ${(err as Error).message}`);
        });

      // Auto-save memory every 5 model turns (~5 complete exchanges).
      if (role !== "model") return;
      turnCountRef.current += 1;
      if (turnCountRef.current - lastMemorySaveRef.current < 5) return;
      lastMemorySaveRef.current = turnCountRef.current;
      void (async () => {
        try {
          const { turns } = await loadTurns();
          if (turns.length < 4) return;
          const transcript = turns
            .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
            .join("\n")
            .slice(0, 60000);
          const sid = sessionIdRef.current || `sess_${Date.now()}`;
          await saveMemory({
            data: {
              sessionId: sid,
              transcript,
              executedSearches: executedSearchesRef.current ?? [],
            },
          });
          const msg = `💾 memory auto-save · turn=${turnCountRef.current} · (model logged server-side)`;
          console.log(`[${new Date().toISOString()}] ${msg}`);
          pushLog("db", msg);
        } catch (e) {
          pushLog("err", `memory auto-save: ${(e as Error).message}`);
        }
      })();
    },
    [saveTurn, pushLog, loadTurns, saveMemory],
  );

  // Fix 48 — fires a code-generated (never LLM-generated) stall phrase the
  // moment the transcript is known, if the transcript matches a known
  // dynamic-knowledge category. Never persisted to DB/history — purely
  // spoken audio. Never blocks or awaits runTurn()'s own execution.
  const playFillerIfMatched = useCallback(
    (transcript: string) => {
      const category = classifyFillerIntent(transcript);
      if (!category) {
        fillerDoneRef.current = Promise.resolve();
        return;
      }
      fillerPlayedThisTurnRef.current = true;
      const phrase = pickFillerPhrase(category);
      fillerDoneRef.current = (async () => {
        try {
          pushLog("evt", `⏱️ filler · category=${category} · "${phrase}"`);
          const tts = await ttsFn({ data: { text: phrase } });
          await playBase64Audio(tts.audioBase64);
        } catch (e) {
          pushLog("err", `filler playback failed: ${(e as Error).message}`);
          // Fail open — never let a filler error block the real answer.
        }
      })();
    },
    [ttsFn, pushLog],
  );




  useEffect(() => {
    let cancelled = false;
    pushLog("db", "→ read today's chat_turns");
    (async () => {
      try {
        const { date, turns } = await loadTurns();
        if (cancelled) return;
        historyRef.current = sanitizeHistory(
          turns.map<GeminiTurn>((t) => ({
            role: t.role,
            parts: [{ text: t.text }],
          })),
        );
        pushLog("db", `✓ hydrated ${turns.length} turn(s) from ${date}`);
      } catch (err) {
        pushLog("err", `hydrate turns: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTurns, pushLog]);

  const loadPromptIfNeeded = useCallback(async () => {
    if (promptLoadingRef.current) return;
    const age = Date.now() - promptLoadedAtRef.current;
    if (age < PROMPT_TTL_MS) return;
    promptLoadingRef.current = true;
    try {
      pushLog("db", "→ read voice session (prompt/context/memory)");
      const session = await fetchSession();
      const nowHK = new Date().toLocaleString("en-GB", {
        timeZone: "Asia/Hong_Kong",
        hour12: false,
      });
      const personaName =
        (session as unknown as { personaName?: string }).personaName ?? "朋友";
      const prompt = buildSystemPrompt(
        session.promptTemplate,
        session.contextText,
        nowHK,
        session.prefetchContext,
        session.memoryContext,
        personaName,
      );
      promptRef.current = prompt;
      personaNameRef.current = personaName;
      promptLoadedAtRef.current = Date.now();
      sessionIdRef.current = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Cache session data needed for contextual greeting + pre-fetch greeting audio.
      const extra = session as unknown as {
        weatherSnippet?: string;
        lastMemorySummary?: string | null;
        daysSinceLastSession?: number | null;
      };
      const sessData = {
        personaName,
        weatherSnippet: extra.weatherSnippet ?? "",
        lastMemorySummary: extra.lastMemorySummary ?? null,
        daysSinceLastSession: extra.daysSinceLastSession ?? null,
      };
      sessionDataRef.current = sessData;

      // Pre-fetch the contextual greeting + TTS so splash tap can play it
      // synchronously inside the user gesture (avoids iOS audio-gesture gap).
      // Shot 1: pre-fetch instant greeting ("你好呀！") — 3 chars, ready in ~1 s.
      if (!shot1AudioRef.current) {
        void (async () => {
          try {
            const tts1 = await ttsFn({ data: { text: "你好呀！" } });
            shot1AudioRef.current = tts1.audioBase64;
            pushLog("evt", "shot1 prefetch · ready");
          } catch (e) {
            pushLog("err", `shot1 prefetch: ${(e as Error).message}`);
          }
        })();
      }
      if (!greetingAudioRef.current) {
        greetingPrefetchRef.current = (async () => {
          try {
            const hkNow = new Date(
              new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }),
            );
            const greetingText = await genGreeting({
              data: {
                personaName: sessData.personaName || "明女",
                hkHour: hkNow.getHours(),
                hkDayOfWeek: hkNow.getDay(),
                weatherSnippet: sessData.weatherSnippet,
                lastMemorySummary: sessData.lastMemorySummary ?? undefined,
                daysSinceLastSession: sessData.daysSinceLastSession ?? undefined,
              },
            });
            const msg = `👋 greeting · text="${greetingText.slice(0, 40)}" · (model logged server-side)`;
            console.log(`[${new Date().toISOString()}] ${msg}`);
            pushLog("evt", msg);
            const tts = await ttsFn({ data: { text: greetingText } });
            greetingAudioRef.current = tts.audioBase64;
            // Late delivery: if the splash was dismissed before this audio
            // was ready and no greeting has played yet and the user hasn't
            // spoken, play the contextual greeting now.
            if (
              !showSplashRef.current &&
              !greetingPlayedRef.current &&
              historyRef.current.length === 0
            ) {
              greetingPlayedRef.current = true;
              try {
                await playBase64Audio(tts.audioBase64);
              } catch (lateErr) {
                pushLog("err", `greeting late play: ${(lateErr as Error).message}`);
              }
            }
          } catch (e) {
            pushLog("err", `greeting prefetch: ${(e as Error).message}`);
          }
        })();
      }

      pushLog("evt", `🕒 HK now: ${nowHK} · persona=${personaName}`);
      pushLog(
        "db",
        `✓ session loaded · ctx:${session.contextText.length} prefetch:${session.prefetchContext.length} memory:${session.memoryContext.length}`,
      );

      // Daily cache metadata — surface what the LLM is reading from prefetch.
      const meta = (session as unknown as {
        cacheMeta?: Array<{ topic: string; updated_at: string; chars: number }>;
      }).cacheMeta;
      if (meta && meta.length > 0) {
        for (const m of meta) {
          const ageMin = Math.round(
            (Date.now() - new Date(m.updated_at).getTime()) / 60000,
          );
          pushLog(
            "db",
            `📦 daily_cache[${m.topic}] · ${m.chars} chars · updated ${m.updated_at} (${ageMin} min ago)`,
          );
        }
      } else {
        pushLog("db", "📦 daily_cache is EMPTY (no prefetch data available)");
      }
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
  }, [fetchSession, pushLog, genGreeting, ttsFn]);

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

  const stopTalkingAndSend = useCallback(async () => {
    const handle = recorderRef.current;
    if (!handle) return;
    recorderRef.current = null;
    // Start keep-alive synchronously from the stop gesture so iOS keeps the
    // audio session open during STT → LLM → TTS.
    startKeepAlive();
    // Re-unlock in this gesture so playback later in the pipeline is authorized.
    try { await unlockAudio(); } catch { /* ignore */ }
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
    pushLog("evt", `recorded ${blob.size}B (${mimeType})`);

    const windowed = historyRef.current.slice(-HISTORY_WINDOW);
    pushLog(
      "evt",
      `🧠 LLM history window: ${windowed.length}/${historyRef.current.length} turns`,
    );

    try {
      fillerDoneRef.current = Promise.resolve();
      fillerPlayedThisTurnRef.current = false;
      await runTurn(
        {
          audio: blob,
          mimeType,
          systemInstruction: promptRef.current + buildNameToken(windowed),
          history: windowed,
          sessionId: sessionIdRef.current,
        },
        {
          transcribe: sttFn,
          plan: planFn,
          executeTool: execToolFn,
          synthesize: synthAnswerFn,
          synthesizeSpeech: ttsFn,
          playAudio: (b64) => fillerDoneRef.current.then(() => playBase64Audio(b64)),
        },
        {
          onTranscribing: () => setStatus("transcribing"),
          onTranscript: (t) => {
            pushLog("user", t);
            transcriptLinesRef.current.push(`USER: ${t}`);
            persistTurn("user", t);
            playFillerIfMatched(t);
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
          onHistory: (h) => {
            // Update history synchronously before TTS/playback — eliminates
            // the race where onDone fires before .then() runs.
            historyRef.current = sanitizeHistory(h);
          },
          onSpeaking: () => {
            setSearching(false);
            setStatus("speaking");
          },
          onLog: (m) => pushLog("evt", m),
          onDone: () => {
            setStatus((s) => (s === "error" ? s : "idle"));
          },
          onError: (msg) => {
            pushLog("err", msg);
            setErrorMsg(msg);
            setStatus("error");
            if (fillerPlayedThisTurnRef.current) {
              void (async () => {
                try {
                  const tts = await ttsFn({
                    data: { text: "唔好意思，搵資料嗰陣出咗少少問題，可唔可以你再問多次？" },
                  });
                  await playBase64Audio(tts.audioBase64);
                } catch {
                  /* best-effort only — never throw from an error handler */
                }
              })();
            }
          },
        },
      );
    } finally {
      stopKeepAlive();
    }
  }, [sttFn, planFn, execToolFn, synthAnswerFn, ttsFn, pushLog, persistTurn, playFillerIfMatched]);

  const startTalking = useCallback(async () => {
    if (
      status === "listening" ||
      status === "transcribing" ||
      status === "thinking"
    ) {
      return;
    }
    if (status === "speaking") {
      stopPlayback();
      stopKeepAlive();
      setStatus("idle");
      return;
    }
    setErrorMsg("");
    // Must happen before any await while still in the tap gesture; this keeps
    // iOS audio alive throughout recording and the later AI/TTS delay.
    startKeepAlive();
    // Refresh the system prompt if its TTL has expired — guarantees voice
    // mode never uses a stale prompt even after a long idle session. The
    // guard inside loadPromptIfNeeded keeps this a no-op when still fresh.
    void loadPromptIfNeeded();
    try {
      await unlockAudio();
      const handle = await startRecording({
        maxDurationMs: 60_000,
        onAutoStop: () => {
          pushLog("evt", "⏱️ auto-stop: 60s max recording reached");
          void stopTalkingAndSend();
        },
      });
      recorderRef.current = handle;
      setStatus("listening");
    } catch (err) {
      stopKeepAlive();
      setErrorMsg((err as Error).message);
      setStatus("error");
      pushLog("err", `mic: ${(err as Error).message}`);
    }
  }, [status, pushLog, stopTalkingAndSend, loadPromptIfNeeded]);

  // Eager warm-up: fetch session/knowledge/memory/daily cache as soon as the
  // component mounts so the very first tap doesn't pay for it. The guard
  // inside loadPromptIfNeeded keeps this a no-op when already fresh.
  useEffect(() => {
    void loadPromptIfNeeded();
  }, [loadPromptIfNeeded]);

  // Text-mode debug: shares the orchestrator's runTurn flow so the plan →
  // tools → synthesise pipeline can never drift between voice and text. STT
  // is skipped (input.text supplied) and TTS is skipped (skipTTS=true).
  const sendTextTurn = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || (textBusy && status !== "speaking")) return;
      if (status === "speaking") stopPlayback();
      const myGen = ++turnGenRef.current;
      setTextBusy(true);
      setErrorMsg("");
      startKeepAlive();
      try {
        await unlockAudio();
        await loadPromptIfNeeded();
        const windowed = historyRef.current.slice(-HISTORY_WINDOW);
        pushLog(
          "evt",
          `🧠 LLM history window: ${windowed.length}/${historyRef.current.length} turns (text mode)`,
        );

        fillerDoneRef.current = Promise.resolve();
        fillerPlayedThisTurnRef.current = false;
        await runTurn(
          {
            text,
            systemInstruction: promptRef.current + buildNameToken(windowed),
            history: windowed,
            sessionId: sessionIdRef.current,
            // skipTTS removed — text-mode replies still speak aloud.
          },
          {
            transcribe: sttFn,
            plan: planFn,
            executeTool: execToolFn,
            synthesize: synthAnswerFn,
            synthesizeSpeech: ttsFn,
            playAudio: (b64) => fillerDoneRef.current.then(() => playBase64Audio(b64)),
          },
          {
            onTranscript: (t) => {
              pushLog("user", `(text) ${t}`);
              transcriptLinesRef.current.push(`USER: ${t}`);
              persistTurn("user", t);
              playFillerIfMatched(t);
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
            onHistory: (h) => {
              historyRef.current = sanitizeHistory(h);
            },
            onSpeaking: () => {
              setSearching(false);
              setStatus("speaking");
            },
            onLog: (m) => pushLog("evt", m),
            onDone: () => {
              setSearching(false);
              setStatus((s) => (s === "error" ? s : "idle"));
            },
            onError: (msg) => {
              pushLog("err", msg);
              setErrorMsg(msg);
              setStatus("error");
              if (fillerPlayedThisTurnRef.current) {
                void (async () => {
                  try {
                    const tts = await ttsFn({
                      data: { text: "唔好意思，搵資料嗰陣出咗少少問題，可唔可以你再問多次？" },
                    });
                    await playBase64Audio(tts.audioBase64);
                  } catch {
                    /* best-effort only — never throw from an error handler */
                  }
                })();
              }
            },
          },
        );
      } finally {
        stopKeepAlive();
        if (turnGenRef.current === myGen) {
          setTextBusy(false);
        }
      }
    },
    [
      textBusy,
      status,
      loadPromptIfNeeded,
      sttFn,
      planFn,
      execToolFn,
      synthAnswerFn,
      ttsFn,
      pushLog,
      persistTurn,
      stopPlayback,
      playFillerIfMatched,
    ],
  );

  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && /^(input|textarea|select)$/i.test(el.tagName);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping()) return;
      e.preventDefault();
      if (status === "listening") void stopTalkingAndSend();
      else void startTalking();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [startTalking, stopTalkingAndSend, status]);

  const tint: "idle" | "listening" | "speaking" =
    status === "speaking"
      ? "speaking"
      : status === "listening"
        ? "listening"
        : "idle";
  const isActive = status === "listening" || status === "speaking";

  const buttonLabel =
    status === "listening"
      ? "撳掣停止"
      : status === "speaking"
        ? "點一下停止"
        : status === "transcribing" || status === "thinking"
          ? "處理緊…"
          : "撳掣開始";

  const buttonDisabled =
    status === "transcribing" || status === "thinking";

  const handleToggle = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      // Drop focus so a subsequent Spacebar press doesn't double-trigger
      // (native button activation + our keydown listener).
      e.currentTarget.blur();
      if (status === "listening") {
        void stopTalkingAndSend();
      } else {
        void startTalking();
      }
    },
    [status, startTalking, stopTalkingAndSend],
  );

  const copyDebugLog = useCallback(() => {
    const text = debugLog
      .map((e) => {
        const ts = new Date(e.t).toISOString();
        return `[${ts}] ${e.kind.toUpperCase()} ${e.text}`;
      })
      .join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => pushLog("evt", "📋 debug log copied to clipboard"),
      (err) => pushLog("err", `copy failed: ${(err as Error).message}`),
    );
  }, [debugLog, pushLog]);

  const handleSplashTap = useCallback(async (e: React.PointerEvent) => {
    e.preventDefault();
    pushLog("evt", "splash tap · priming iOS audio");
    // Keep-alive must be started synchronously inside the pointer gesture.
    startKeepAlive();
    setGreeting(true);
    // Hide splash IMMEDIATELY (before awaiting audio unlock) so the user sees
    // instant feedback on tap. The orb screen has its own loading state.
    setShowSplash(false);
    showSplashRef.current = false;
    // Unlock audio in the background — still inside the pointer gesture window,
    // so iOS will accept the resume() call.
    try {
      await unlockAudio();
    } catch (err) {
      pushLog("err", `unlock: ${(err as Error).message}`);
    }
    void loadPromptIfNeeded();
    try {
      // SHOT 1: Play instant "你好呀！" immediately — gives the user immediate audio
      // feedback in the gesture window while the full LLM greeting loads.
      if (shot1AudioRef.current) {
        try { await playBase64Audio(shot1AudioRef.current); } catch (e) {
          pushLog("err", `shot1 playback: ${(e as Error).message}`);
        }
      }
      // SHOT 2: Wait for the personalized LLM greeting from the background pre-fetch.
      let audioBase64 = greetingAudioRef.current;
      if (!audioBase64 && greetingPrefetchRef.current) {
        // Wait up to 45 s — observed LLM greeting call takes ~27 s; 45 s covers slow networks.
        try {
          await Promise.race([
            greetingPrefetchRef.current,
            new Promise<void>((_, rej) =>
              setTimeout(() => rej(new Error("prefetch wait timeout 45000ms")), 45000),
            ),
          ]);
        } catch (e) {
          pushLog("err", `greeting prefetch wait: ${(e as Error).message}`);
        }
        audioBase64 = greetingAudioRef.current;
      }
      if (!audioBase64) {
        // Ultimate fallback: simple time-of-day greeting via TTS only (fast, no LLM).
        try {
          const fallbackText = getTimeGreeting(personaNameRef.current ?? "明女");
          const tts = await ttsFn({ data: { text: fallbackText } });
          audioBase64 = tts.audioBase64;
        } catch (e) {
          pushLog("err", `greeting fallback tts: ${(e as Error).message}`);
        }
      }
      if (audioBase64) {
        greetingPlayedRef.current = true;
        try { await playBase64Audio(audioBase64); } catch (e) {
          pushLog("err", `greeting playback: ${(e as Error).message}`);
        }
      }
    } catch (err) {
      pushLog("err", `greeting: ${(err as Error).message}`);
    } finally {
      stopKeepAlive();
      setGreeting(false);
    }
  }, [ttsFn, pushLog, loadPromptIfNeeded, genGreeting]);



  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center overflow-hidden bg-[oklch(0.18_0.04_265)] px-6 py-6 text-white">
      <div className="flex w-full items-start justify-between">
        <div className="text-left">
          <div className="text-3xl font-black tracking-tight">傾偈</div>
          <div className="mt-1 text-sm text-white/60">
            Voice Companion · <span className="text-white/80">REST · LLM={providers.llm} · TTS={providers.tts} · v{APP_VERSION}</span>
          </div>
        </div>
      </div>

      {/* Debug text-mode input — skips STT, fires plan→tools→synth directly. */}
      <div className="mt-4 w-full max-w-xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = textInput;
            setTextInput("");
            void sendTextTurn(t);
          }}
          className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-3"
        >
          <span className="text-base text-white/40">💬</span>
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Type a message…"
            className="flex-1 bg-transparent text-lg text-white placeholder-white/30 outline-none"
          />
          <button
            type="submit"
            disabled={(textBusy && status !== "speaking") || !textInput.trim()}
            className="rounded-full bg-amber-300 px-4 py-2 text-base font-bold text-orange-950 disabled:opacity-40"
          >
            {status === "speaking" ? "明女講緊…" : textBusy ? "…" : "Send"}
          </button>
        </form>
      </div>

      <div className="relative mt-3 flex w-full items-center justify-center">
        <div className="relative aspect-square w-[68vw] max-w-[340px]">
          <WaveformOrb getAnalyser={() => null} active={isActive} tint={tint} />
          <button
            type="button"
            disabled={buttonDisabled}
            onClick={(e) => {
              e.preventDefault();
              handleToggle(e);
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={[
              "absolute inset-[18%] select-none whitespace-pre-line rounded-full text-2xl font-black tracking-wide shadow-2xl transition-transform active:scale-95",
              status === "listening"
                ? "animate-pulse bg-gradient-to-br from-rose-500 to-red-600 text-white"
                : status === "speaking"
                  ? "bg-gradient-to-br from-sky-400 to-indigo-500 text-white"
                  : buttonDisabled
                    ? "bg-white/10 text-white/40"
                    : "bg-gradient-to-br from-amber-300 to-orange-400 text-orange-950",
              status === "idle" ? "animate-vc-pulse" : "",
            ].join(" ")}
            style={{ touchAction: "manipulation" }}
          >
            {buttonLabel}
          </button>
        </div>
      </div>

      <div className="mt-5 w-full text-center">
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
        <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs text-white/40">
          <span>v{APP_VERSION}</span>
          <button
            type="button"
            onClick={() => setDebugOpen((v) => !v)}
            className="rounded-full border border-white/20 px-3 py-1 text-white/60 hover:bg-white/5"
          >
            {debugOpen ? "Hide debug" : "Show debug"} ({debugLog.length})
          </button>
          {hasReplay && status !== "speaking" && !textBusy ? (
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


      <div className="flex-1" />

      {showSplash ? (
        <div
          className="fixed inset-0 z-[60] flex flex-col items-center justify-between bg-[oklch(0.18_0.04_265)]/95 px-6 py-16 text-white backdrop-blur"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="text-5xl font-black tracking-tight">傾偈</div>
            <div className="text-base text-white/70">
              {new Date().toLocaleDateString("en-GB", {
                timeZone: "Asia/Hong_Kong",
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </div>
          </div>

          <button
            type="button"
            onPointerDown={handleSplashTap}
            disabled={greeting}
            className="flex h-56 w-56 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-orange-400 text-orange-950 shadow-2xl transition-all active:scale-95 active:from-emerald-400 active:to-emerald-600 active:text-white disabled:from-emerald-400 disabled:to-emerald-600 disabled:text-white disabled:opacity-100"
            style={{ touchAction: "manipulation" }}
            aria-label="Start"
          >
            {greeting ? (
              <span className="inline-block h-16 w-16 animate-spin rounded-full border-4 border-orange-950/30 border-t-orange-950" />
            ) : (
              <svg width="80" height="80" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <div className="text-center text-sm text-white/60">
            {greeting ? "準備緊,請稍候…" : "點擊開始 · 啟動音訊通道"}
          </div>
        </div>
      ) : null}


      {debugOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-50 max-h-[55vh] overflow-y-auto border-t border-white/10 bg-black/80 p-3 text-xs backdrop-blur">
          <div className="mb-2 flex items-center justify-between sticky top-0 bg-black/80 py-1 gap-2">
            <div className="font-mono text-white/70">Debug ({debugLog.length})</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyDebugLog}
                className="rounded border border-sky-300/40 bg-sky-400/10 px-2 py-0.5 text-sky-200 hover:bg-sky-400/20"
              >
                📋 Copy log
              </button>
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
                aria-label="Close debug"
              >
                ✕ Close
              </button>
            </div>
          </div>
          {debugLog.length === 0 ? (
            <div className="text-white/40">No events yet. Tap the button to start.</div>
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
                          : e.kind === "db"
                            ? "text-fuchsia-300"
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
                          : e.kind === "db"
                            ? "DB "
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
          <div className="sticky bottom-0 mt-3 flex justify-end gap-2 bg-black/80 py-2">
            <button
              type="button"
              onClick={copyDebugLog}
              className="rounded border border-sky-300/40 bg-sky-400/10 px-2 py-0.5 text-sky-200 hover:bg-sky-400/20"
            >
              📋 Copy
            </button>
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
      ) : null}
    </div>
  );
}
