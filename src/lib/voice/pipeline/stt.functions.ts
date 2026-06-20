// Layer 1: Speech-to-Text. Provider: Deepgram (nova-3, zh-HK / Cantonese).
// Accepts a multipart/form-data upload with the audio blob attached as the
// `audio` field and the original `mimeType` as a text field. This avoids the
// triple base64 round-trip (client encode → server decode → upload) that was
// adding noticeable CPU + 33% payload bloat on every turn.
import { createServerFn } from "@tanstack/react-start";

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((d: FormData) => {
    if (!(d instanceof FormData)) {
      throw new Error("transcribeAudio expects FormData");
    }
    return d;
  })
  .handler(async ({ data }) => {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error("Missing DEEPGRAM_API_KEY on server");

    const audio = data.get("audio");
    const mimeType = (data.get("mimeType") as string) || "audio/webm";
    if (!(audio instanceof Blob)) {
      throw new Error("transcribeAudio: missing audio blob");
    }

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
          "Content-Type": mimeType,
        },
        body: audio,
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
