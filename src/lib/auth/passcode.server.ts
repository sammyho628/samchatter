// Server-only HMAC helpers for the app passcode gate. The `.server.ts`
// extension prevents this module from being pulled into client bundles.
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

export function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function issueSessionToken(): { token: string; expiresAt: number } {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not configured");
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + TOKEN_TTL_SECONDS };
  const payloadPart = b64url(JSON.stringify(payload));
  const sig = sign(payloadPart, secret);
  return { token: `${payloadPart}.${sig}`, expiresAt: payload.exp };
}

export function verifySessionTokenServer(token: string | null | undefined): boolean {
  if (!token) return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadPart, sig] = parts;
  const expected = sign(payloadPart, secret);
  if (!safeEqualStr(sig, expected)) return false;
  try {
    const payload = JSON.parse(fromB64url(payloadPart).toString("utf8")) as { exp?: number };
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}
