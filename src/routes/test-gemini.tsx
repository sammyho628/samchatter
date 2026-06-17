import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getVoiceSession } from "@/lib/voice/session.functions";

export const Route = createFileRoute("/test-gemini")({
  head: () => ({ meta: [{ title: "Gemini Live — Connection Test" }] }),
  component: TestGeminiPage,
});

type LogLine = { t: string; msg: string };

const CANDIDATES = [
  // (label, wss URL path, model name in setup)
  {
    label: "v1beta · gemini-live-2.5-flash-native-audio",
    path: "v1beta",
    model: "models/gemini-live-2.5-flash-native-audio",
  },
  {
    label: "v1alpha · gemini-live-2.5-flash-native-audio",
    path: "v1alpha",
    model: "models/gemini-live-2.5-flash-native-audio",
  },
  {
    label: "v1beta · gemini-2.5-flash-preview-native-audio-dialog",
    path: "v1beta",
    model: "models/gemini-2.5-flash-preview-native-audio-dialog",
  },
  {
    label: "v1alpha · gemini-2.5-flash-preview-native-audio-dialog",
    path: "v1alpha",
    model: "models/gemini-2.5-flash-preview-native-audio-dialog",
  },
  {
    label: "v1beta · gemini-2.0-flash-exp (known-working baseline)",
    path: "v1beta",
    model: "models/gemini-2.0-flash-exp",
  },
];

function TestGeminiPage() {
  const fetchSession = useServerFn(getVoiceSession);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const log = (msg: string) =>
    setLogs((prev) => [
      ...prev,
      { t: new Date().toISOString().slice(11, 23), msg },
    ]);

  const testOne = (apiKey: string, c: (typeof CANDIDATES)[number]) =>
    new Promise<void>((resolve) => {
      const url =
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${c.path}.GenerativeService.BidiGenerateContent?key=` +
        encodeURIComponent(apiKey);
      log(`▶ ${c.label}`);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        resolve();
      };

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      const timeout = window.setTimeout(() => {
        log(`  ⏱ timeout after 8s`);
        done();
      }, 8000);

      ws.onopen = () => {
        log(`  ✓ ws.open — sending setup (FunctionDeclarations format)`);
        const setupMessage = {
          setup: {
            model: c.model,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
              },
            },
            systemInstruction: {
              parts: [
                {
                  text:
                    "You are a HK Cantonese voice companion. If the user asks about news, prices, weather, stocks, or local places, you MUST call web_search or search_places FIRST before answering.",
                },
              ],
            },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "web_search",
                    description:
                      "Use this for current events, news, financial markets, product recommendations, and health facts.",
                    parameters: {
                      type: "OBJECT",
                      properties: {
                        query: {
                          type: "STRING",
                          description:
                            "The search query. ALWAYS append specific site routing rules as instructed.",
                        },
                      },
                      required: ["query"],
                    },
                  },
                  {
                    name: "search_places",
                    description:
                      "Use this EXCLUSIVELY to find physical addresses, restaurants, or local shops in Hong Kong.",
                    parameters: {
                      type: "OBJECT",
                      properties: {
                        query: {
                          type: "STRING",
                          description:
                            "The location search query in Traditional Chinese.",
                        },
                      },
                      required: ["query"],
                    },
                  },
                ],
              },
            ],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        };
        ws.send(JSON.stringify(setupMessage));
      };
      ws.onmessage = async (ev) => {
        let text = "";
        if (typeof ev.data === "string") text = ev.data;
        else if (ev.data instanceof Blob) text = await ev.data.text();
        else if (ev.data instanceof ArrayBuffer)
          text = new TextDecoder().decode(ev.data);
        const snippet = text.length > 280 ? text.slice(0, 280) + "…" : text;
        log(`  ← message: ${snippet}`);
        try {
          const parsed = JSON.parse(text);
          if (parsed.setupComplete) {
            log(`  ✅ setupComplete — model + tools accepted`);
            window.clearTimeout(timeout);
            done();
          } else if (parsed.toolCall) {
            log(`  🔧 toolCall: ${JSON.stringify(parsed.toolCall)}`);
          } else if (
            parsed.serverContent?.modelTurn?.parts?.[0]?.functionCall
          ) {
            log(
              `  🔧 functionCall (modelTurn): ${JSON.stringify(parsed.serverContent.modelTurn.parts[0].functionCall)}`,
            );
          } else if (parsed.error) {
            log(`  ❌ error: ${JSON.stringify(parsed.error)}`);
            window.clearTimeout(timeout);
            done();
          }
        } catch {}
      };
      ws.onerror = () => log(`  ⚠ ws.error`);
      ws.onclose = (ev) => {
        log(
          `  ⛔ ws.close code=${ev.code} reason="${ev.reason ?? ""}" clean=${ev.wasClean}`,
        );
        window.clearTimeout(timeout);
        done();
      };
    });

  const runAll = async () => {
    setLogs([]);
    setRunning(true);
    try {
      log("Fetching session from server…");
      const { geminiKey } = await fetchSession();
      log(`Got key (${geminiKey.length} chars). Starting tests…`);
      for (const c of CANDIDATES) {
        await testOne(geminiKey, c);
      }
      log("Done.");
    } catch (err) {
      log(`Fatal: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[oklch(0.18_0.04_265)] px-6 py-8 text-white">
      <h1 className="text-2xl font-black tracking-tight">
        Gemini Live — Connection Test
      </h1>
      <p className="mt-2 text-sm text-white/60">
        Opens a WebSocket to Gemini Live with each model/endpoint candidate and
        logs the response.
      </p>

      <button
        onClick={runAll}
        disabled={running}
        className="mt-6 rounded-full bg-amber-300 px-6 py-3 text-base font-bold text-orange-950 shadow-xl disabled:opacity-50"
      >
        {running ? "Testing…" : "Run tests"}
      </button>

      <pre className="mt-6 max-h-[60dvh] overflow-auto rounded-xl bg-black/40 p-4 text-xs leading-relaxed whitespace-pre-wrap">
        {logs.length === 0
          ? "(no output yet)"
          : logs.map((l) => `[${l.t}] ${l.msg}`).join("\n")}
      </pre>
    </div>
  );
}
