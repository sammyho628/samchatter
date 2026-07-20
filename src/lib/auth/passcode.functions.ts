import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 365 days

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const verifyPasscode = createServerFn({ method: "POST" })
  .inputValidator((data: { passcode: string }) =>
    z.object({ passcode: z.string().min(1).max(256) }).parse(data),
  )
  .handler(async ({ data }) => {
    const expected = process.env.APP_PASSCODE;
    const secret = process.env.SESSION_SECRET;
    if (!expected || !secret) {
      throw new Error("Server is not configured for passcode auth.");
    }

    if (!safeEqual(data.passcode, expected)) {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw new Response(
        JSON.stringify({ success: false, message: "Invalid passcode" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = { iat: now, exp: now + TOKEN_TTL_SECONDS };
    const payloadPart = b64url(JSON.stringify(payload));
    const sig = sign(payloadPart, secret);
    return { success: true as const, token: `${payloadPart}.${sig}`, expiresAt: payload.exp };
  });

export const verifySessionToken = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string }) =>
    z.object({ token: z.string().min(1).max(2048) }).parse(data),
  )
  .handler(async ({ data }) => {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return { valid: false as const };
    const parts = data.token.split(".");
    if (parts.length !== 2) return { valid: false as const };
    const [payloadPart, sig] = parts;
    const expected = sign(payloadPart, secret);
    if (!safeEqual(sig, expected)) return { valid: false as const };
    try {
      const payload = JSON.parse(fromB64url(payloadPart).toString("utf8")) as { exp?: number };
      if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
        return { valid: false as const };
      }
      return { valid: true as const, expiresAt: payload.exp };
    } catch {
      return { valid: false as const };
    }
  });
