// Layer 1: Speech-to-Text. Provider: Deepgram (nova-2, zh-HK / Cantonese).
// Pure REST. Swap by rewriting this one handler.
import { createServerFn } from "@tanstack/react-start";

export type TranscribeInput = {
  audioBase64: string;
  mimeType: string; // e.g. "audio/webm;codecs=opus" | "audio/mp4"
};

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((d: TranscribeInput) => d)
  .handler(async ({ data }) => {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error("Missing DEEPGRAM_API_KEY on server");

    const bin = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0));

    // nova-2 supports many languages incl. zh; zh-HK is the closest tag.
    // smart_format + punctuate keep transcripts readable.
    const params = new URLSearchParams({
      model: "nova-3",
      language: "zh-HK",
      punctuate: "true",
      smart_format: "true",
    });
    const resp = await fetch(
      `https://api.deepgram.com/v1/listen?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${key}`,
          "Content-Type": data.mimeType || "audio/webm",
        },
        body: bin,
      },
    );
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Deepgram ${resp.status}: ${t.slice(0, 300)}`);
    }
    const json = (await resp.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{ transcript?: string }>;
        }>;
      };
    };
    const transcript =
      json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    return { transcript };
  });
