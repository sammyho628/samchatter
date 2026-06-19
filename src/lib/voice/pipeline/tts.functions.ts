// Layer 3: Text-to-Speech via Gemini API (Generative Language API).
// Uses the Gemini API key (AI Studio), NOT the Google Cloud TTS endpoint.
// Gemini returns raw PCM (signed 16-bit LE, mono, 24kHz). We wrap it in a
// WAV header server-side so the browser's AudioContext.decodeAudioData()
// can play it without any custom PCM handling on the client.
import { createServerFn } from "@tanstack/react-start";

export type SynthesizeInput = {
  text: string;
  voice?: string; // e.g. "Kore", "Puck", "Charon", "Fenrir", "Aoede"
};

// NOTE: Google does not ship a "gemini-3.1-flash-tts-preview" model on the
// Gemini AI Studio API. The actual available preview TTS model is
// gemini-2.5-flash-preview-tts (responseModalities: ["AUDIO"]). Using the
// fictional 3.1 name returns 404 and the client hears silence.
const MODEL = "gemini-2.5-flash-preview-tts";

function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(bin);
}

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .inputValidator((d: SynthesizeInput) => d)
  .handler(async ({ data }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY on server");
    const text = data.text.trim();
    if (!text) throw new Error("Empty text for synthesizeSpeech");
    const voiceName = data.voice ?? "Kore";

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        }),
        signal: ctl.signal,
      },
    ).finally(() => clearTimeout(timer));
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("[TTS] Gemini error", resp.status, t.slice(0, 400));
      throw new Error(`Gemini TTS ${resp.status}: ${t.slice(0, 400)}`);
    }
    const json = (await resp.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string; mimeType?: string };
          }>;
        };
      }>;
    };
    const part = json.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData?.data,
    );
    const inline = part?.inlineData;
    if (!inline?.data) throw new Error("Gemini TTS returned no audio data");

    // mimeType looks like "audio/L16;codec=pcm;rate=24000"
    const mime = inline.mimeType ?? "audio/L16;codec=pcm;rate=24000";
    const rateMatch = /rate=(\d+)/i.exec(mime);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

    const pcm = Uint8Array.from(atob(inline.data), (ch) => ch.charCodeAt(0));
    const wav = pcm16ToWav(pcm, sampleRate);
    return { audioBase64: bytesToBase64(wav), mimeType: "audio/wav" };
  });
