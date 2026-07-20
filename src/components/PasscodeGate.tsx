import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { verifyPasscode } from "@/lib/auth/passcode.functions";
import {
  clearStoredToken,
  isTokenLive,
  readStoredToken,
  storeToken,
} from "@/lib/auth/token";

type AuthState = "checking" | "locked" | "unlocked";

const AUTH_EVENT = "app-auth-change";

function emitAuthChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_EVENT));
  }
}

export function signOut() {
  clearStoredToken();
  emitAuthChange();
}

export function PasscodeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");

  const revalidate = useCallback(() => {
    setState(isTokenLive(readStoredToken()) ? "unlocked" : "locked");
  }, []);

  useEffect(() => {
    revalidate();
    const onChange = () => revalidate();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "app_session_token") revalidate();
    };
    window.addEventListener(AUTH_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(AUTH_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [revalidate]);

  if (state === "checking") {
    return <div className="min-h-screen bg-background" />;
  }
  if (state === "unlocked") {
    return <>{children}</>;
  }
  return <LoginScreen onUnlock={() => emitAuthChange()} />;
}

function LoginScreen({ onUnlock }: { onUnlock: () => void }) {
  const verify = useServerFn(verifyPasscode);
  const [passcode, setPasscode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!passcode || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await verify({ data: { passcode } });
      if (res?.success && res.token) {
        storeToken(res.token);
        onUnlock();
      } else {
        setError("Invalid passcode");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|invalid passcode/i.test(msg)) {
        setError("Invalid passcode");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-card/60 p-6 shadow-xl backdrop-blur"
      >
        <h1 className="text-2xl font-semibold text-foreground">傾吓偈</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the passcode to continue.
        </p>
        <label className="mt-6 block">
          <span className="sr-only">Passcode</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            inputMode="text"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            disabled={loading}
            placeholder="Passcode"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base text-foreground outline-none ring-offset-background transition focus:ring-2 focus:ring-ring"
          />
        </label>
        {error ? (
          <div className="mt-3 text-sm text-red-400" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={loading || !passcode}
          className="mt-5 w-full rounded-lg bg-primary px-4 py-3 text-base font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {loading ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
