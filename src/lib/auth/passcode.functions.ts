import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  issueSessionToken,
  safeEqualStr,
  verifySessionTokenServer,
} from "./passcode.server";

// In-memory sliding-window rate limiter: 5 attempts / 60s per IP.
// Lives in the Worker instance; resets on cold start. Good enough as a
// backstop against automated guessing; pair with Cloudflare WAF for
// stronger protection.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const attempts = new Map<string, number[]>();

function clientIp(): string {
  const h =
    getRequestHeader("cf-connecting-ip") ||
    getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ||
    getRequestHeader("x-real-ip") ||
    "unknown";
  return h;
}

function checkRate(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const arr = (attempts.get(ip) ?? []).filter((t) => t > cutoff);
  if (arr.length >= RATE_MAX) {
    const retryAfter = Math.ceil((arr[0] + RATE_WINDOW_MS - now) / 1000);
    attempts.set(ip, arr);
    return { ok: false, retryAfter };
  }
  arr.push(now);
  attempts.set(ip, arr);
  // Opportunistic cleanup to keep the map bounded.
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) {
      const filtered = v.filter((t) => t > cutoff);
      if (filtered.length === 0) attempts.delete(k);
      else attempts.set(k, filtered);
    }
  }
  return { ok: true, retryAfter: 0 };
}

export const verifyPasscode = createServerFn({ method: "POST" })
  .inputValidator((data: { passcode: string }) =>
    z.object({ passcode: z.string().min(1).max(256) }).parse(data),
  )
  .handler(async ({ data }) => {
    const ip = clientIp();
    const rate = checkRate(ip);
    if (!rate.ok) {
      throw new Response(
        JSON.stringify({
          success: false,
          message: `太多次嘗試，請 ${rate.retryAfter} 秒後再試。`,
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(rate.retryAfter),
          },
        },
      );
    }

    const expected = process.env.APP_PASSCODE;
    if (!expected) throw new Error("Server is not configured for passcode auth.");

    if (!safeEqualStr(data.passcode, expected)) {
      throw new Response(
        JSON.stringify({ success: false, message: "Invalid passcode" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const { token, expiresAt } = issueSessionToken();
    return { success: true as const, token, expiresAt };
  });


export const verifySessionToken = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string }) =>
    z.object({ token: z.string().min(1).max(2048) }).parse(data),
  )
  .handler(async ({ data }) => {
    return { valid: verifySessionTokenServer(data.token) };
  });
