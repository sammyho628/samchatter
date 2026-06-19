// Master orchestrator. STT → LLM → (sentence-chunked TTS pipelined with playback).
// Sentence chunking lets the first sentence's audio start playing while later
// sentences are still being synthesized — eliminates "silent wait" before
// long replies.
import type { GeminiTurn, ToolCallTrace } from "./llm.functions";

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
  transcribe: (input: {
    data: { audioBase64: string; mimeType: string };
  }) => Promise<{ transcript: string }>;
  generate: (input: {
    data: {
      systemInstruction: string;
      history: GeminiTurn[];
      userText: string;
    };
  }) => Promise<{
    text: string;
    history: GeminiTurn[];
    toolCalls: ToolCallTrace[];
  }>;
  synthesize: (input: {
    data: { text: string };
  }) => Promise<{ audioBase64: string; mimeType: string }>;
  playAudio: (b64: string) => Promise<void>;
};

export type TurnInput = {
  audioBase64: string;
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

/** Split text into speakable chunks. First chunk = up to first sentence
 *  terminator (CJK or ASCII). Subsequent chunks keep accumulating sentences
 *  but cap each chunk to ~80 chars so TTS round-trips stay short. */
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

  // Merge tiny pieces forward to avoid 1-char TTS calls.
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

/** Browser-native SpeechSynthesis fallback when remote TTS fails (e.g. MiniMax
 *  rate-limit or invalid voice id). Resolves when utterance ends or after a
 *  hard timeout so the turn never hangs. */
function speakBrowserFallback(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      // Cantonese first; browser picks closest available if missing.
      u.lang = "zh-HK";
      const done = () => resolve();
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      // Safety timeout: ~150ms/char, min 3s, max 20s.
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
    const { transcript } = await deps.transcribe({
      data: { audioBase64: input.audioBase64, mimeType: input.mimeType },
    });
    if (!transcript) {
      cbs.onError?.("聽唔清楚，可唔可以講多次？");
      cbs.onDone?.();
      return null;
    }
    cbs.onTranscript?.(transcript);

    cbs.onThinking?.();
    const result = await deps.generate({
      data: {
        systemInstruction: input.systemInstruction,
        history: input.history,
        userText: transcript,
      },
    });
    for (const tc of result.toolCalls) cbs.onToolCall?.(tc);
    cbs.onAssistantText?.(result.text);
    cbs.onHistory?.(result.history);

    // Sentence-chunked TTS: dispatch all in parallel, play in order.
    const sentences = splitIntoSentences(result.text);
    if (sentences.length === 0) {
      cbs.onDone?.();
      return {
        transcript,
        assistantText: result.text,
        history: result.history,
        toolCalls: result.toolCalls,
      };
    }
    cbs.onLog?.(`🔊 TTS chunks: ${sentences.length}`);
    const ttsPromises = sentences.map((s) =>
      deps.synthesize({ data: { text: s } }).catch((err: Error) => ({
        __error: err.message,
      })),
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
      assistantText: result.text,
      history: result.history,
      toolCalls: result.toolCalls,
    };
  } catch (e) {
    cbs.onError?.((e as Error).message);
    cbs.onDone?.();
    return null;
  }
}
