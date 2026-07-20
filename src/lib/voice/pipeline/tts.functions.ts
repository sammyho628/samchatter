// Layer 3: Text-to-Speech.
// Dispatches to either Google Gemini TTS (default) or MiniMax speech-02-hd
// (Cantonese) based on the provider configured in app_settings.
import { createServerFn } from "@tanstack/react-start";
import { requireAppPasscode } from "@/lib/auth/passcode.middleware";
import { readProvidersServerSide } from "@/lib/voice/providerSettings.functions";

export type SynthesizeInput = {
  text: string;
  voice?: string; // Gemini voice name only
};

const GEMINI_MODEL = "gemini-2.5-flash-preview-tts";
const MINIMAX_MODEL = "speech-02-hd";
const MINIMAX_DEFAULT_VOICE = "Cantonese_Articulate_commentator_vv2";
const MINIMAX_ENDPOINT = "https://api.minimaxi.chat/v1/t2a_v2";

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
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

async function synthesizeGemini(text: string, voice: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY on server");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
      signal: ctl.signal,
    },
  ).finally(() => clearTimeout(timer));
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini TTS ${resp.status}: ${t.slice(0, 400)}`);
  }
  const json = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
    ?.inlineData;
  if (!inline?.data) throw new Error("Gemini TTS returned no audio data");
  const mime = inline.mimeType ?? "audio/L16;codec=pcm;rate=24000";
  const rateMatch = /rate=(\d+)/i.exec(mime);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const pcm = Uint8Array.from(atob(inline.data), (ch) => ch.charCodeAt(0));
  const wav = pcm16ToWav(pcm, sampleRate);
  return { audioBase64: bytesToBase64(wav), mimeType: "audio/wav" };
}

async function synthesizeMinimax(text: string) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("Missing MINIMAX_API_KEY on server");
  const groupId = process.env.MINIMAX_GROUP_ID;
  const voiceId = process.env.MINIMAX_VOICE_ID || MINIMAX_DEFAULT_VOICE;

  const url = groupId
    ? `${MINIMAX_ENDPOINT}?GroupId=${encodeURIComponent(groupId)}`
    : MINIMAX_ENDPOINT;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      text,
      stream: false,
      language_boost: "Chinese,Yue",
      voice_setting: {
        voice_id: voiceId,
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
    signal: ctl.signal,
  }).finally(() => clearTimeout(timer));

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    console.error("[TTS] MiniMax error", resp.status, t.slice(0, 400));
    throw new Error(`MiniMax TTS ${resp.status}: ${t.slice(0, 400)}`);
  }
  const json = (await resp.json()) as {
    data?: { audio?: string; status?: number };
    base_resp?: { status_code?: number; status_msg?: string };
    trace_id?: string;
  };
  const status = json.base_resp?.status_code ?? 0;
  if (status !== 0) {
    throw new Error(
      `MiniMax TTS error ${status}: ${json.base_resp?.status_msg ?? "unknown"} (trace=${json.trace_id ?? "n/a"})`,
    );
  }
  const audioHex = json.data?.audio;
  if (!audioHex) throw new Error("MiniMax TTS returned no audio data");
  const bytes = hexToBytes(audioHex);
  return { audioBase64: bytesToBase64(bytes), mimeType: "audio/mpeg" };
}

/** Strip engine-bracket artifacts that occasionally leak from OpenRouter
 *  models into the synthesized text (e.g. "[web_search(query=...)]",
 *  "[search_places ...]"). These would otherwise be read out loud by
 *  MiniMax / Gemini TTS as raw code, which sounds terrible. Also normalises
 *  markdown bullet/header noise that violates the prose principle. */
function sanitizeForTTS(raw: string): string {
  let s = raw;
  // Strip [tool_name ...] style artifacts (web_search/search_places/scrape_page/function/tool_call)
  s = s.replace(/\[(?:web_search|search_places|scrape_page|function|tool[_ ]?call|tool[_ ]?result)[^\]]*\]/gi, "");
  // Strip ```code fences``` and inline backticks
  s = s.replace(/```[\s\S]*?```/g, "").replace(/`+/g, "");
  // Strip markdown bold/italic/header/divider markers
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-=]{3,}\s*$/gm, "");
  // Strip leading bullet/numbered-list markers at line start
  s = s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "");
  // Collapse residual multi-newlines / multi-spaces to natural prose spacing
  s = s.replace(/\n{2,}/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  return s;
}

async function synthesizeLovableGateway(text: string) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY for TTS fallback");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Lovable-API-Key": key,
      "Content-Type": "application/json",
      "X-Lovable-AIG-SDK": "raw-fetch",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini-tts",
      input: text,
      voice: "alloy",
      response_format: "mp3",
    }),
    signal: ctl.signal,
  }).finally(() => clearTimeout(timer));
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Lovable TTS ${resp.status}: ${t.slice(0, 400)}`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  return { audioBase64: bytesToBase64(buf), mimeType: "audio/mpeg" };
}

export const synthesizeSpeech = createServerFn({ method: "POST" }).middleware([requireAppPasscode])
  .inputValidator((d: SynthesizeInput) => d)
  .handler(async ({ data }) => {
    const text = sanitizeForTTS(data.text.trim());
    if (!text) throw new Error("Empty text for synthesizeSpeech");
    const { tts } = await readProvidersServerSide();
    if (tts === "minimax") {
      try {
        return await synthesizeMinimax(text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[TTS] MiniMax failed, falling back to Lovable Gateway:", msg);
        return await synthesizeLovableGateway(text);
      }
    }
    try {
      return await synthesizeGemini(text, data.voice ?? "Kore");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[TTS] Gemini failed, falling back to Lovable Gateway:", msg);
      return await synthesizeLovableGateway(text);
    }
  });
