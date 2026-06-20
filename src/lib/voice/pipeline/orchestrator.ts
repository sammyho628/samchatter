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
  audio: Blob;
  mimeType: string;
  systemInstruction: string;
  history: GeminiTurn[];
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
  const TERMINATORS = /([。！？!?\.…]+["”』）)]*\s*)/g;
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

export async function runTurn(
  input: TurnInput,
  deps: TurnDeps,
  cbs: TurnCallbacks = {},
): Promise<TurnOutput | null> {
  try {
    cbs.onTranscribing?.();
    const fd = new FormData();
    fd.append("audio", input.audio, "recording");
    fd.append("mimeType", input.mimeType);
    const { transcript } = await deps.transcribe({ data: fd });
    if (!transcript) {
      cbs.onError?.("聽唔清楚，可唔可以講多次？");
      cbs.onDone?.();
      return null;
    }
    cbs.onTranscript?.(transcript);

    cbs.onThinking?.();

    // PHASE 1 — PLAN
    const plan = await deps.plan({
      data: {
        systemInstruction: input.systemInstruction,
        history: input.history,
        userText: transcript,
      },
    });
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
          deps
            .executeTool({ data: c })
            .catch(
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
      finalText = plan.directAnswer;
      finalHistory = [
        ...input.history,
        { role: "user", parts: [{ text: transcript }] },
        { role: "model", parts: [{ text: finalText }] },
      ];
    } else {
      const syn = await deps.synthesize({
        data: {
          systemInstruction: input.systemInstruction,
          history: input.history,
          userText: transcript,
          toolResults,
        },
      });
      finalText = syn.text;
      finalHistory = syn.history;
    }

    cbs.onAssistantText?.(finalText);
    cbs.onHistory?.(finalHistory);

    const sentences = splitIntoSentences(finalText);
    if (sentences.length === 0) {
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
      deps
        .synthesizeSpeech({ data: { text: s } })
        .catch((err: Error) => ({ __error: err.message })),
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
