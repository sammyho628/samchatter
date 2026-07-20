export const SESSION_STORAGE_KEY = "app_session_token";

function fromB64url(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob !== "undefined") return atob(b64);
  // Fallback (SSR): Buffer not imported to keep this file browser-safe.
  return "";
}

/** Lightweight client-side check: token is well-formed and not expired.
 *  Signature validity is enforced server-side on every server-fn call the
 *  gate protects; this is only used to decide whether to render the gate. */
export function isTokenLive(token: string | null | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const payload = JSON.parse(fromB64url(parts[0])) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
