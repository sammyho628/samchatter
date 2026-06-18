// Layer 3: Text-to-Speech. Provider: Google Cloud TTS, yue-HK Wavenet.
// REST → returns base64 MP3 the client decodes with AudioContext.decodeAudioData.
import { createServerFn } from "@tanstack/react-start";

export type SynthesizeInput = {
  text: string;
  voice?: string; // e.g. "yue-HK-Standard-A" | "yue-HK-Standard-B" | "yue-HK-Standard-C" | "yue-HK-Standard-D"
};

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .inputValidator((d: SynthesizeInput) => d)
  .handler(async ({ data }) => {
    const key = process.env.GOOGLE_TTS_API_KEY;
    if (!key) throw new Error("Missing GOOGLE_TTS_API_KEY on server");
    const text = data.text.trim();
    if (!text) throw new Error("Empty text for synthesizeSpeech");

    const voiceName = data.voice ?? "yue-HK-Standard-B"; // male
    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: "yue-HK", name: voiceName },
          audioConfig: {
            audioEncoding: "MP3",
            sampleRateHertz: 24000,
            speakingRate: 1.0,
          },
        }),
      },
    );
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Google TTS ${resp.status}: ${t.slice(0, 300)}`);
    }
    const json = (await resp.json()) as { audioContent?: string };
    if (!json.audioContent) throw new Error("Google TTS returned no audioContent");
    return { audioBase64: json.audioContent, mimeType: "audio/mpeg" };
  });
