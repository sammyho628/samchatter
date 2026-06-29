// Master orchestrator. STT → Planner → parallel tool execution → Synthesiser →
// sentence-chunked TTS pipelined with playback.
//
// v1.15.0: decoupled the LLM brain into two phases (plan + synthesise) so the
// orchestrator drives tool execution explicitly instead of letting the LLM
// run a hidden multi-step tool loop. This makes tool calls observable, lets
// us run them in parallel, and keeps the synthesiser strictly factual.
import type {
  GeminiTurn,
  PlannedToolCall,
  QueryPlan,
  ToolCallTrace,
} from "./llm.functions";

export type TurnCallbacks = {
  onListening?: () => void;
  onTranscribing?: () => void;
  onTranscript?: (text: string) => void;
  onThinking?: () => void;
  onToolCall?: (t: ToolCallTrace) => void;
  onAssistantText?: (text: string) => void;
  onHistory?: (history: GeminiTurn[]) => void;
  onSpeaking?: () => void;
  onDone?: () => void;
  onError?: (msg: string) => void;
  onLog?: (msg: string) => void;
};

export type TurnDeps = {
  transcribe: (input: { data: FormData }) => Promise<{ transcript: string }>;
  plan: (input: {
    data: {
      systemInstruction: string;
      history: GeminiTurn[];
      userText: string;
    };
  }) => Promise<QueryPlan>;
  executeTool: (input: { data: PlannedToolCall }) => Promise<ToolCallTrace>;
  synthesize: (input: {
    data: {
      systemInstruction: string;
      history: GeminiTurn[];
      userText: string;
      toolResults: ToolCallTrace[];
    };
  }) => Promise<{ text: string; history: GeminiTurn[] }>;
  synthesizeSpeech: (input: {
    data: { text: string };
  }) => Promise<{ audioBase64: string; mimeType: string }>;
  playAudio: (b64: string) => Promise<void>;
};

export type TurnInput = {
  // Either provide raw audio (voice mode) or pre-supplied text (text-mode debug).
  audio?: Blob;
  mimeType?: string;
  text?: string;
  systemInstruction: string;
  history: GeminiTurn[];
  skipTTS?: boolean;
};

export type TurnOutput = {
  transcript: string;
  assistantText: string;
  history: GeminiTurn[];
  toolCalls: ToolCallTrace[];
};

function splitIntoSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const TERMINATORS = /([。！？!?…]+["”』）)]*\s*)/g;
  const pieces: string[] = [];
  let buf = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINATORS.exec(t)) !== null) {
    const end = m.index + m[0].length;
    buf += t.slice(last, end);
    last = end;
    if (buf.trim().length >= 1) {
      pieces.push(buf.trim());
      buf = "";
    }
  }
  if (last < t.length) buf += t.slice(last);
  if (buf.trim()) pieces.push(buf.trim());

  const out: string[] = [];
  for (const p of pieces) {
    if (out.length && out[out.length - 1].length < 8) {
      out[out.length - 1] += p;
    } else {
      out.push(p);
    }
  }
  return out;
}

function speakBrowserFallback(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-HK";
      const done = () => resolve();
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      setTimeout(done, Math.min(20000, Math.max(3000, text.length * 150)));
    } catch {
      resolve();
    }
  });
}

// Retry a transient fetch failure exactly once. Targets the Safari/WebKit
// "TypeError: Load failed" and generic network errors that bubble up from
// `useServerFn` calls when the edge connection blips.
function isTransientNetworkError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  // Timeout errors: the server already spent its full time budget — retrying wastes
  // another equal amount of time for zero gain.
  if (/timeout/i.test(msg)) return false;
  // "Failed to fetch" after a long wait (>30 s) means the platform dropped the
  // server-side connection (edge-function execution limit reached). Retrying
  // causes a second identical 2-minute hang before failing again.
  if (/failed to fetch/i.test(msg)) return false;
  return /load failed|network|fetch failed|networkerror/i.test(msg);
}

async function retryOnce<T>(
  label: string,
  fn: () => Promise<T>,
  onLog?: (m: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    onLog?.(`🔁 ${label} failed (${(err as Error).message}) — retrying once`);
    return await fn();
  }
}

export async function runTurn(
  input: TurnInput,
  deps: TurnDeps,
  cbs: TurnCallbacks = {},
): Promise<TurnOutput | null> {
  try {
    let transcript: string;
    if (input.text !== undefined) {
      // Text-mode debug path — skip STT entirely.
      transcript = input.text.trim();
    } else {
      if (!input.audio || !input.mimeType) {
        cbs.onError?.("缺少音訊輸入。");
        cbs.onDone?.();
        return null;
      }
      cbs.onTranscribing?.();
      const fd = new FormData();
      fd.append("audio", input.audio, "recording");
      fd.append("mimeType", input.mimeType);
      let stt: { transcript: string };
      try {
        stt = await retryOnce("STT", () => deps.transcribe({ data: fd }), cbs.onLog);
        transcript = stt.transcript;
      } catch (sttErr) {
        const sttMsg = (sttErr as Error).message ?? "";
        cbs.onLog?.(`⚠️ STT failed: ${sttMsg}`);
        const isSttTimeout = /522|timeout|connection|load failed/i.test(sttMsg);
        const fallbackText = isSttTimeout
          ? "唔好意思呀，頭先好似收唔到你把聲，不如你再講多次吖？"
          : "唔好意思，出咗啲問題，可唔可以再試多次？";
        cbs.onSpeaking?.();
        try {
          const tts = await deps.synthesizeSpeech({ data: { text: fallbackText } });
          await deps.playAudio(tts.audioBase64);
        } catch { /* ignore TTS failure in fallback */ }
        cbs.onDone?.();
        return null;
      }
    }
    if (!transcript) {
      cbs.onError?.("聽唔清楚，可唔可以講多次？");
      cbs.onDone?.();
      return null;
    }
    cbs.onTranscript?.(transcript);

    cbs.onThinking?.();

    // PHASE 1 — PLAN
    const plan = await retryOnce(
      "plan",
      () =>
        deps.plan({
          data: {
            systemInstruction: input.systemInstruction,
            history: input.history,
            userText: transcript,
          },
        }),
      cbs.onLog,
    );
    cbs.onLog?.(
      `🧭 plan · tools=${plan.toolCalls.length}` +
        (plan.analytical ? " · analytical" : "") +
        (plan.directAnswer ? " · directAnswer" : ""),
    );

    // PHASE 2 — EXECUTE TOOLS (parallel)
    let toolResults: ToolCallTrace[] = [];
    if (plan.toolCalls.length > 0) {
      toolResults = await Promise.all(
        plan.toolCalls.map((c) =>
          retryOnce(`tool:${c.name}`, () => deps.executeTool({ data: c }), cbs.onLog).catch(
            (err: Error): ToolCallTrace => ({
              name: c.name,
              args: c.args,
              summary: `Error: ${err.message}`,
            }),
          ),
        ),
      );
      for (const tc of toolResults) cbs.onToolCall?.(tc);
    }

    // PHASE 3 — SYNTHESISE
    // If the planner already produced a direct answer AND no tools were
    // needed, skip the second LLM round-trip and reuse the planner's text.
    let finalText: string;
    let finalHistory: GeminiTurn[];
    if (plan.toolCalls.length === 0 && plan.directAnswer) {
      finalText = plan.directAnswer
        .replace(/\[TOOL CALLS\][\s\S]*?\[\/TOOL CALLS\]/gi, "")
        .replace(/\[TOOL RESULTS\][\s\S]*?\[\/TOOL RESULTS\]/gi, "")
        .trim();
      finalHistory = [
        ...input.history,
        { role: "user", parts: [{ text: transcript }] },
        { role: "model", parts: [{ text: finalText }] },
      ];
    } else {
      const syn = await retryOnce(
        "synthesize",
        () =>
          deps.synthesize({
            data: {
              systemInstruction: input.systemInstruction,
              history: input.history,
              userText: transcript,
              toolResults,
            },
          }),
        cbs.onLog,
      );
      finalText = syn.text;
      finalHistory = syn.history;
    }

    cbs.onAssistantText?.(finalText);
    cbs.onHistory?.(finalHistory);

    const sentences = splitIntoSentences(finalText);
    if (input.skipTTS || sentences.length === 0) {
      cbs.onDone?.();
      return {
        transcript,
        assistantText: finalText,
        history: finalHistory,
        toolCalls: toolResults,
      };
    }
    cbs.onLog?.(`🔊 TTS chunks: ${sentences.length}`);
    const ttsPromises = sentences.map((s) =>
      retryOnce("TTS", () => deps.synthesizeSpeech({ data: { text: s } }), cbs.onLog).catch(
        (err: Error) => ({ __error: err.message }),
      ),
    );
    cbs.onSpeaking?.();
    for (let i = 0; i < ttsPromises.length; i++) {
      const tts = await ttsPromises[i];
      if (tts && "__error" in tts) {
        cbs.onLog?.(`⚠️ TTS failed (${tts.__error}) — browser fallback`);
        await speakBrowserFallback(sentences[i]);
      } else {
        try {
          await deps.playAudio(tts.audioBase64);
        } catch (err) {
          cbs.onLog?.(
            `⚠️ Playback failed (${(err as Error).message}) — browser fallback`,
          );
          await speakBrowserFallback(sentences[i]);
        }
      }
    }
    cbs.onDone?.();

    return {
      transcript,
      assistantText: finalText,
      history: finalHistory,
      toolCalls: toolResults,
    };
  } catch (e) {
    cbs.onError?.((e as Error).message);
    cbs.onDone?.();
    return null;
  }
}
