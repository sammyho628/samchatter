import { createFileRoute } from "@tanstack/react-router";

// WebSocket proxy: browser <-> this Worker <-> DashScope.
// The browser cannot set an `Authorization: Bearer` header on a WebSocket,
// so we accept the upgrade here and open the upstream WS with the proper header
// using the server-side API key.
export const Route = createFileRoute("/api/public/qwen-proxy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const upgrade = request.headers.get("upgrade")?.toLowerCase();
        if (upgrade !== "websocket") {
          return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
          return new Response("Server missing DASHSCOPE_API_KEY", { status: 500 });
        }

        const url = new URL(request.url);
        const model =
          url.searchParams.get("model") || "qwen3-omni-flash-realtime";
        // Workers initiate outbound WebSocket handshakes via fetch() to the
        // HTTPS endpoint plus `Upgrade: websocket`; using a `wss:` URL here
        // can fail before DashScope accepts the upgrade.
        const upstreamUrl = `https://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;

        // Open upstream WS by issuing a fetch with Upgrade headers.
        // This is Cloudflare Workers' supported pattern.
        let upstreamResp: Response;
        try {
          upstreamResp = await fetch(upstreamUrl, {
            headers: {
              Upgrade: "websocket",
              Authorization: `Bearer ${apiKey}`,
            },
          });
        } catch (e) {
          console.error("[qwen-proxy] upstream connect failed", (e as Error).message);
          return new Response(`Upstream connect failed: ${(e as Error).message}`, { status: 502 });
        }

        // @ts-expect-error — Cloudflare Workers extension
        const upstream: WebSocket | null = upstreamResp.webSocket;
        if (!upstream) {
          const txt = await upstreamResp.text().catch(() => "");
          console.error("[qwen-proxy] upstream did not upgrade", upstreamResp.status, txt.slice(0, 500));
          return new Response(
            `Upstream did not upgrade (status ${upstreamResp.status}): ${txt.slice(0, 500)}`,
            { status: 502 }
          );
        }

        // @ts-expect-error — Cloudflare Workers global
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        (server as unknown as { accept: () => void }).accept();
        // @ts-expect-error — Cloudflare-only method
        upstream.accept();


        // Pipe both directions
        const closeBoth = (code = 1000, reason = "") => {
          try { server.close(code, reason); } catch {}
          try { upstream.close(code, reason); } catch {}
        };

        server.addEventListener("message", (ev: MessageEvent) => {
          try {
            upstream.send(ev.data);
          } catch (e) {
            closeBoth(1011, `proxy->upstream send: ${(e as Error).message}`);
          }
        });
        upstream.addEventListener("message", (ev: MessageEvent) => {
          try {
            server.send(ev.data);
          } catch (e) {
            closeBoth(1011, `upstream->client send: ${(e as Error).message}`);
          }
        });


        server.addEventListener("close", (ev: CloseEvent) => {
          try { upstream.close(ev.code, ev.reason); } catch {}
        });
        upstream.addEventListener("close", (ev: CloseEvent) => {
          try { server.close(ev.code, ev.reason); } catch {}
        });
        server.addEventListener("error", () => closeBoth(1011, "client error"));
        upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

        return new Response(null, {
          status: 101,
          // @ts-expect-error — Cloudflare-only response init field
          webSocket: client,
        });
      },
    },
  },
});
