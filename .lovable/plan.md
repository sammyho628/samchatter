
## Goal

Replace the WebSocket realtime voice loop (Qwen / Gemini Live + raw PCM streaming) with a clean, decoupled REST pipeline driven by a push-to-talk button. Three swappable modules, one orchestrator, no manual PCM alignment.

```text
[ Mic + PTT button ]
        │ webm/opus blob
        ▼
 Layer 1: transcribeAudio()  ── Deepgram (nova-2, zh-HK)
        │ text
        ▼
 Layer 2: generateAIResponse() ── Gemini 2.5 Flash (+ tools loop)
        │ text
        ▼
 Layer 3: synthesizeSpeech()   ── Google Cloud TTS (yue-HK Wavenet)
        │ mp3 ArrayBuffer
        ▼
 AudioContext.decodeAudioData() → play
```

Each layer is a single async function with one input and one output, called from server functions so API keys stay server-side. Swapping a provider = rewrite one function.

## Secrets needed (request via add_secret)

- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_TTS_API_KEY` (Google Cloud API key with Text-to-Speech API enabled — can be the same key as Gemini if the project has both APIs enabled, but kept separate for clarity)

## File plan

### New — Layer modules (server functions, `createServerFn`)

- `src/lib/voice/pipeline/stt.functions.ts` — `transcribeAudio(blob)` server fn. Accepts base64-encoded audio + mime type, POSTs to Deepgram `/v1/listen?model=nova-2&language=zh-HK&punctuate=true&smart_format=true`, returns `{ transcript: string }`.
- `src/lib/voice/pipeline/llm.functions.ts` — `generateAIResponse({ history, userText })` server fn. Calls Gemini 2.5 Flash `generateContent` with the existing hard-wired system prompt (reused from `systemPrompt.ts`) + tool declarations (`web_search`, `search_places`). Runs the tool loop server-side: when Gemini returns a `functionCall`, invoke the existing `web-search` / `search-places` edge functions, append `functionResponse`, re-call Gemini, repeat until a plain text response or a max-step cap (6). Returns `{ text, updatedHistory, toolCalls[] }`.
- `src/lib/voice/pipeline/tts.functions.ts` — `synthesizeSpeech(text)` server fn. POSTs to `https://texttospeech.googleapis.com/v1/text:synthesize?key=…` with `{ input:{text}, voice:{ languageCode:"yue-HK", name:"yue-HK-Standard-A" }, audioConfig:{ audioEncoding:"MP3", sampleRateHertz:24000 } }`. Returns `{ audioBase64, mimeType:"audio/mpeg" }`.

All three are pure REST, no streaming, no SSE — keeps the contract trivial and swappable.

### New — Client orchestrator

- `src/lib/voice/pipeline/orchestrator.ts` — `runTurn(blob, history, callbacks)` runs STT → LLM → TTS sequentially, firing UI callbacks: `onListening`, `onTranscript(text)`, `onThinking`, `onToolCall(name,args)`, `onSpeaking`, `onAssistantText(text)`, `onDone`. No retry/reconnect logic — failures bubble up as toasts.
- `src/lib/voice/pipeline/recorder.ts` — thin `MediaRecorder` wrapper for push-to-talk: `start()` / `stop()` returns a Blob. Picks the best supported mime type (`audio/webm;codecs=opus` → `audio/mp4` fallback for Safari).
- `src/lib/voice/pipeline/player.ts` — `playAudioBlob(arrayBuffer)`: a single shared `AudioContext`, `decodeAudioData`, `AudioBufferSourceNode.start(currentTime + 0.05)`. Stops any prior source first (kills overlap). No PCM math, no chunk scheduling.

### Updated

- `src/components/VoiceCompanion.tsx` — rip out `QwenLiveClient` / `AudioEngine` walkie-talkie wiring. Replace mic toggle with a **press-and-hold "Hold to Talk"** button (pointerdown/pointerup, plus pointercancel + space-bar). UI states: Idle → Listening → Transcribing → Thinking → Speaking → Idle. Keep existing prompt-debug panel, replay-last-buffer button (now replays last MP3 ArrayBuffer), memory/cache prefetch, version banner.
- `src/lib/version.ts` — bump to `1.5.0` (architecture change).
- `src/lib/voice/systemPrompt.ts` — reused as-is for Gemini. The tool-call "verbal trap" rules are no longer needed (Gemini's `functionCall` is structured, not text) but left in place — they don't hurt.

### Kept but unused (per user choice)

- `src/lib/voice/qwenLive.ts`
- `src/lib/voice/geminiLive.ts`
- `src/lib/voice/audioEngine.ts`
- `src/lib/voice/pcm-worklet.ts`
- `src/routes/api/public/qwen-proxy.ts`
- `src/routes/testqwen.tsx`, `src/routes/test-gemini.tsx`

No imports from `VoiceCompanion.tsx` will reference these after the refactor; tree-shaking handles the rest. A comment at the top of each notes "Deprecated — replaced by src/lib/voice/pipeline/* in v1.5.0".

## Tool-calling loop (Layer 2 detail)

```text
loop (max 6 iterations):
  call Gemini with contents=history
  if response has functionCall:
      run tool (web-search / search-places edge fn)
      append { role: "model", parts: [{ functionCall }] }
      append { role: "function", parts: [{ functionResponse:{ name, response:{ result } } }] }
      continue
  else:
      return text + final history
```

Tool declarations re-use the same schemas already in `geminiLive.ts` (`web_search`, `search_places`) so behaviour and trusted-domain routing in the `web-search` edge function are unchanged.

## Push-to-talk UX

- Big circular "按住講嘢" button center-screen.
- `pointerdown` → start recorder, label → "🎤 聽緊…"
- `pointerup` / `pointercancel` → stop recorder, kick orchestrator.
- Keyboard: hold Spacebar to talk (when not focused in an input).
- During Thinking/Speaking the button is disabled (greyed). Tapping during Speaking stops playback and returns to Idle (barge-in lite).

## What this fixes

- **Audio jitter / stutter / overlapping voices** — gone. Single decoded MP3, played once via `AudioBufferSourceNode`.
- **30s WebSocket idle timeout, heartbeat hacks, reconnect storms** — gone. Stateless HTTP.
- **"Verbal trap" tool-call hesitation** — Gemini emits structured `functionCall`, not text.
- **Race conditions between parallel tool calls and `response.create`** — orchestrator is strictly sequential.
- **VAD hang on mute** — replaced by explicit push-to-talk.

## Out of scope

- Streaming TTS (Google REST returns a complete file; fine for short replies).
- Barge-in mid-AI-speech beyond "tap to stop".
- Migrating existing chat memory / daily cache schemas — they remain and feed the system prompt unchanged.

## Verification

1. `bun run build` clean.
2. Push-to-talk: hold → speak Cantonese → release → transcript bubble appears → assistant text → audio plays once, no stutter.
3. Ask "今日香港天氣？" → confirm `web_search` tool fires (console log) and answer cites it.
4. Ask "邊度有好食嘅茶餐廳？" → confirm `search_places` fires.
5. Hold-and-release with no speech → graceful "聽唔清楚" toast, no crash.
6. Network throttle → STT/LLM/TTS errors surface as toasts, UI returns to Idle.
