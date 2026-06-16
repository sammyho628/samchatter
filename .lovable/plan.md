
# Voice Companion — Plan

A mobile-first (iPhone) web app that streams speech-to-speech Cantonese conversation with Google Gemini Live, using context fetched from a user-supplied Supabase table.

## Scope & assumptions
- **Credentials**: Gemini API key, Supabase URL, and Supabase anon key are entered by the user in an in-app Settings panel and stored in `localStorage`. No Lovable Cloud / backend is enabled — the user explicitly wants their own Supabase + direct browser → Gemini WebSocket. (Note: putting the Gemini key in the browser exposes it to anyone using the deployed site; acceptable for a personal tool, flagging it here.)
- **Supabase table**: `Voice-Bot-1`, column `content_text`. Fetched once per session start via `supabase-js` with the anon key (RLS must allow anon select).
- **Model**: `gemini-2.5-flash` over `BidiGenerateContent` WebSocket. Native audio in (16kHz PCM) and audio out (24kHz PCM).
- Single page, no auth, no routing changes beyond the existing `/` route.

## UX (locked mobile viewport)
- Update `__root.tsx` head meta to `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0`.
- One screen:
  - Top-right: small gear icon → opens Settings sheet (3 inputs + Save).
  - Center: massive circular **Start Conversation** button (≥70vw). States: `idle` (pulsing), `connecting`, `listening` (cool glow + waveform), `speaking` (warm glow + waveform), `error`.
  - Reactive waveform/glow ring driven by an `AnalyserNode` on whichever stream is active (mic when listening, AI when speaking).
  - Large Cantonese labels: 開始傾偈 / 停止.
- High contrast, oversized text, generous spacing. Tailwind tokens added to `styles.css`.

## Audio pipeline
1. **User gesture unlock (inside button onClick, before anything async)**:
   - `new AudioContext({ sampleRate: 24000 })` for playback, plus a separate `AudioContext({ sampleRate: 16000 })` for capture (Safari requires the resume call synchronously in the gesture).
   - `await ctx.resume()` on both.
2. **Mic capture**: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
3. **PCM encoding**: `AudioWorkletNode` (with inline worklet module) downsamples to 16kHz mono, converts Float32 → Int16 little-endian, batches ~100ms chunks, base64-encodes, and posts back to main thread.
4. **Send to Gemini**: each chunk wrapped as `{"realtimeInput":{"mediaChunks":[{"mimeType":"audio/pcm;rate=16000","data":"<base64>"}]}}`.
5. **Playback**: incoming `serverContent.modelTurn.parts[].inlineData` (audio/pcm;rate=24000) decoded from base64 → Int16 → Float32 → scheduled into an `AudioBufferSourceNode` queue with a running `nextStartTime` cursor for gapless playback. Each queued source is tracked so it can be stopped.
6. **Barge-in**: a lightweight RMS check in the worklet flags voice activity. When RMS crosses threshold AND playback queue is non-empty, main thread stops all queued sources, clears the queue, and resets `nextStartTime`.

## Gemini WebSocket
- URL: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=<API_KEY>`
- First message — `BidiGenerateContentSetup`:
  ```json
  {
    "setup": {
      "model": "models/gemini-2.5-flash",
      "generationConfig": { "responseModalities": ["AUDIO"] },
      "systemInstruction": { "parts": [{ "text": "<filled template>" }] }
    }
  }
  ```
- System instruction = the provided Cantonese template with `[INSERT ...]` replaced by concatenated `content_text` rows.
- Handle inbound: `setupComplete` → start mic streaming; `serverContent` audio parts → enqueue playback; `turnComplete` → mark AI idle; errors → surface in UI.

## Supabase context fetch
- On Start: create `createClient(url, anonKey)`, `select('content_text').from('Voice-Bot-1')`, join non-empty rows with `\n\n`, inject into system prompt. Cache for the session.

## File plan
- `src/routes/__root.tsx` — update viewport meta + title.
- `src/routes/index.tsx` — render `<VoiceCompanion />`.
- `src/components/VoiceCompanion.tsx` — main UI, state machine (idle/connecting/listening/speaking/error), gear button.
- `src/components/SettingsSheet.tsx` — shadcn `Sheet` with three inputs + save to localStorage.
- `src/components/WaveformOrb.tsx` — canvas/SVG visualizer driven by an AnalyserNode ref.
- `src/lib/voice/settings.ts` — load/save localStorage (`vc.geminiKey`, `vc.supabaseUrl`, `vc.supabaseAnonKey`).
- `src/lib/voice/supabaseContext.ts` — fetch + concat `content_text`.
- `src/lib/voice/geminiLive.ts` — WebSocket client (connect, sendSetup, sendAudioChunk, onAudio, close).
- `src/lib/voice/audioEngine.ts` — AudioContext init, mic capture, worklet wiring, playback queue, barge-in stop.
- `src/lib/voice/pcm-worklet.ts` — string export of the AudioWorklet source (registered via `Blob` URL so it works without a separate public file).
- `src/lib/voice/systemPrompt.ts` — template + interpolation.
- `src/styles.css` — add glow/pulse keyframes and large-touch tokens.
- `package.json` — add `@supabase/supabase-js`.

## Technical notes / risks
- iOS Safari: AudioContext + `resume()` must run synchronously inside the click handler — implemented before any `await`.
- AudioWorklet over `ScriptProcessorNode` for stable 16kHz resampling on iOS.
- Gemini key in browser is inherently exposed; documented in Settings UI with a warning.
- If `Voice-Bot-1` RLS blocks anon, fetch will fail — surfaced as a clear error in the UI before connecting.
- No persistence of transcripts; this is purely live voice.

Approve and I'll build it.
