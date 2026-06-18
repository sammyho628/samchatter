// Master orchestrator. Pure sequential STT → LLM → TTS pipeline.
// Each layer is a separate server function and can be swapped independently.
import type { GeminiTurn, ToolCallTrace } from "./llm.functions";

export type TurnCallbacks = {
  onListening?: () => void;
  onTranscribing?: () => void;
  onTranscript?: (text: string) => void;
  onThinking?: () => void;
  onToolCall?: (t: ToolCallTrace) => void;
  onAssistantText?: (text: string) => void;
  onSpeaking?: () => void;
  onDone?: () => void;
  onError?: (msg: string) => void;
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
  playAudio: (b64: string, onEnded?: () => void) => Promise<void>;
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

    const tts = await deps.synthesize({ data: { text: result.text } });
    cbs.onSpeaking?.();
    await deps.playAudio(tts.audioBase64, () => cbs.onDone?.());

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
