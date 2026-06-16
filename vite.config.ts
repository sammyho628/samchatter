// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { WebSocket, WebSocketServer } from "ws";

function qwenDevWebSocketProxy(): Plugin {
  return {
    name: "qwen-dev-websocket-proxy",
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const requestUrl = request.url ?? "";
        if (!requestUrl.startsWith("/api/public/qwen-proxy")) return;

        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
          socket.write("HTTP/1.1 500 Missing DASHSCOPE_API_KEY\r\n\r\n");
          socket.destroy();
          return;
        }

        const model = new URL(requestUrl, "http://localhost").searchParams.get("model") || "qwen3-omni-flash-realtime";
        const upstream = new WebSocket(
          `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );

        const fail = (message: string) => {
          try {
            socket.write(`HTTP/1.1 502 ${message}\r\n\r\n`);
          } catch {}
          socket.destroy();
        };

        const timer = setTimeout(() => fail("Qwen upstream timeout"), 12_000);
        upstream.once("open", () => {
          clearTimeout(timer);
          wss.handleUpgrade(request, socket, head, (client) => {
            client.on("message", (data, isBinary) => upstream.send(data, { binary: isBinary }));
            upstream.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
            client.on("close", (code, reason) => upstream.close(code, reason.toString()));
            upstream.on("close", (code, reason) => client.close(code, reason.toString()));
            client.on("error", () => upstream.close(1011, "client error"));
            upstream.on("error", () => client.close(1011, "upstream error"));
          });
        });
        upstream.once("error", (error) => {
          clearTimeout(timer);
          fail(error instanceof Error ? error.message : "Qwen upstream error");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [qwenDevWebSocketProxy()],
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
