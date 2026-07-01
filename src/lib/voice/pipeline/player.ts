// Single shared AudioContext + decodeAudioData. No PCM math, no chunk math.
// stop() before each start kills overlap → never two voices at once.
//
// ── Single Alive Audio Track Principle ──────────────────────────────────────
// The AudioContext is created EXACTLY ONCE inside a user-gesture frame and
// is NEVER closed or replaced mid-session. A long-lived silent oscillator is
// attached to the destination at unlock time and runs forever, which forces
// iOS Safari to keep the audio session active across long idle gaps.
//
// When playback stalls (suspended mid-session, no onended), we DO NOT destroy
// the context. We perform a "node refresh": briefly disconnect and reconnect
// our master GainNode to the destination to flush the iOS hardware buffer.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let keepAliveOsc: OscillatorNode | null = null;
let current: AudioBufferSourceNode | null = null;
let lastBuffer: AudioBuffer | null = null;
const listeners = new Set<(has: boolean) => void>();

// Diagnostic logger — subscribed by the UI so audio failures show up in the
// in-app debug panel, not just devtools.
type DiagLogger = (msg: string) => void;
const diagListeners = new Set<DiagLogger>();
function diag(msg: string) {
  const line = `[player] ${msg}`;
  try { console.log(line); } catch { /* ignore */ }
  for (const l of diagListeners) {
    try { l(line); } catch { /* ignore */ }
  }
}
export function subscribePlayerDiagnostics(fn: DiagLogger): () => void {
  diagListeners.add(fn);
  return () => diagListeners.delete(fn);
}

function ensureCtx(): AudioContext {
  // Zombie detection: keepAliveOsc !== null means the context was previously
  // running (oscillator attached in unlockAudio). If it is now suspended or
  // interrupted, iOS has killed it permanently — destroy it and recreate.
  // A freshly-created context where keepAliveOsc is still null may also be
  // suspended on iOS before the first user gesture — that is normal, not a zombie.
  if (ctx && keepAliveOsc !== null && (ctx.state === "suspended" || (ctx.state as string) === "interrupted")) {
    diag(`AudioContext zombie detected · state=${ctx.state} · destroying and recreating`);
    try { keepAliveOsc.stop(); } catch { /* already stopped */ }
    try { ctx.close(); } catch { /* ignore */ }
    ctx = null;
    masterGain = null;
    keepAliveOsc = null;
  }
  if (ctx) return ctx;
  const AC: typeof AudioContext =
    (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = 1.0;
  masterGain.connect(ctx.destination);
  diag(`AudioContext created · state=${ctx.state} · sampleRate=${ctx.sampleRate}`);
  return ctx;
}

/** Node refresh: disconnect/reconnect the master GainNode to flush the iOS
 *  hardware buffer when audio stalls. Does NOT close or replace the context. */
function refreshGraph(): void {
  if (!ctx || !masterGain) return;
  try {
    masterGain.disconnect();
    masterGain.connect(ctx.destination);
    diag("node refresh · masterGain re-attached to destination");
  } catch (err) {
    diag(`node refresh failed: ${(err as Error).message}`);
  }
}

/** Call once inside a user gesture (pointerdown) so iOS Safari unlocks audio.
 *  Attaches a permanent silent oscillator that keeps the audio session alive
 *  for the lifetime of the page. NEVER closes/recreates the context. */
export async function unlockAudio(): Promise<void> {
  const c = ensureCtx();
  const before = c.state;

  // Synchronously play a 1-sample silent buffer inside the gesture frame —
  // this is the actual iOS unlock primitive.
  try {
    const buf = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch (err) {
    diag(`unlock silent-buffer failed: ${(err as Error).message}`);
  }

  if (c.state === "suspended") {
    try {
      await Promise.race([
        c.resume(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("resume timeout 1500ms")), 1500),
        ),
      ]);
    } catch (err) {
      diag(`⚠️ resume failed/slow: ${(err as Error).message} (continuing)`);
    }
  }

  // Attach the long-lived silent oscillator ONCE. Runs forever so iOS keeps
  // the media session active across chat gaps.
  if (!keepAliveOsc && masterGain) {
    try {
      const osc = c.createOscillator();
      const g = c.createGain();
      g.gain.value = 0.001; // completely inaudible
      osc.connect(g);
      g.connect(c.destination);
      osc.start(0);
      keepAliveOsc = osc;
      diag(`keepAlive oscillator · attached forever · ctx=${c.state}`);
    } catch (err) {
      diag(`keepAlive osc start failed: ${(err as Error).message}`);
    }
  }

  diag(`unlockAudio · ${before} → ${c.state}`);
}

// Resume on foreground / gesture — context is never closed, just resumed.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx && ctx.state === "suspended") {
      ctx.resume().then(
        () => diag("visibility resume ok"),
        (e) => diag(`visibility resume failed: ${(e as Error).message}`),
      );
    }
  });
  const resumeOnGesture = () => {
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().then(
      () => diag("gesture resume ok"),
      (e) => diag(`gesture resume failed: ${(e as Error).message}`),
    );
  };
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener("pointerdown", resumeOnGesture, opts);
  window.addEventListener("touchstart", resumeOnGesture, opts);
  window.addEventListener("keydown", resumeOnGesture, opts);
}

export function stopPlayback() {
  if (current) {
    try {
      current.stop();
      current.disconnect();
    } catch {
      /* ignore */
    }
    current = null;
  }
}

/** Play an audio clip. Resolves when playback ends (or is stopped).
 *  Never destroys the AudioContext — uses node refresh to recover from stalls. */
export async function playBase64Audio(audioBase64: string): Promise<void> {
  const c = ensureCtx();
  if (c.state === "suspended") {
    diag("playBase64Audio · context suspended, attempting resume (no recreate)");
    try {
      await Promise.race([
        c.resume(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("resume timeout 1500ms")), 1500),
        ),
      ]);
    } catch (err) {
      diag(`⚠️ resume failed at play time: ${(err as Error).message}`);
    }
    if ((c.state as string) !== "running") {
      // Single-Alive-Track principle: do NOT recreate. Try node refresh and
      // proceed — silent oscillator should be holding the session open.
      refreshGraph();
      diag(`⚠️ ctx still ${c.state} after resume; proceeding with node-refresh`);
    }
  }

  const bytes = Uint8Array.from(atob(audioBase64), (ch) => ch.charCodeAt(0));
  const ab = bytes.buffer.slice(0) as ArrayBuffer;
  diag(`playBase64Audio · ctx=${c.state} · inputBytes=${bytes.length}`);
  const scheduleAt = c.currentTime + 0.1;
  let buffer: AudioBuffer;
  try {
    buffer = await c.decodeAudioData(ab);
  } catch (err) {
    diag(`⚠️ decodeAudioData failed: ${(err as Error).message}`);
    throw err;
  }
  if (c.state === "suspended") {
    diag("playBase64Audio · ctx suspended post-decode — resume + node refresh");
    try { await c.resume(); } catch { /* ignore */ }
    refreshGraph();
  }
  stopPlayback();
  return new Promise<void>((resolve) => {
    let cleaned = false;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const target: AudioNode = masterGain ?? c.destination;
    try {
      src.connect(target);
    } catch (err) {
      diag(`⚠️ audio node disconnected: ${(err as Error).message}`);
      resolve();
      return;
    }

    // On mid-playback suspend/interrupt: try resume + node refresh.
    // Never close or replace the context.
    const onStateChange = () => {
      if ((c.state as string) === "interrupted" || c.state === "suspended") {
        diag(`⚠️ ctx ${c.state} mid-playback — resume + node refresh`);
        c.resume().then(
          () => {
            diag(`✓ ctx resume() ok · state=${c.state}`);
            refreshGraph();
            setTimeout(() => {
              if (cleaned) return;
              diag(`⚠️ onended silent 2s after resume · ctx=${c.state} — force resolve (no recreate)`);
              cleanup();
              resolve();
            }, 2000);
          },
          (e) => {
            diag(`⚠️ auto-resume failed: ${(e as Error).message} — node refresh + force resolve`);
            refreshGraph();
            cleanup();
            resolve();
          },
        );
      }
    };
    c.addEventListener("statechange", onStateChange);

    // Safety timer — force-resolve without destroying ctx.
    const safetyMs = Math.max(50000, Math.ceil((buffer.duration + 3) * 1000));
    const safetyTimer = setTimeout(() => {
      cleanup();
      diag(`⚠️ playback safety timeout after ${(buffer.duration + 3).toFixed(1)}s · ctx=${c.state} — force resolve (no recreate)`);
      refreshGraph();
      resolve();
    }, safetyMs);

    const expectedEndTime = scheduleAt + buffer.duration;
    const pollTimer = setInterval(() => {
      if (cleaned) { clearInterval(pollTimer); return; }
      if (c.currentTime > expectedEndTime + 1.0) {
        clearInterval(pollTimer);
        diag(`⚠️ onended not fired ${(c.currentTime - expectedEndTime).toFixed(1)}s past expected end — force resolve (no recreate)`);
        refreshGraph();
        cleanup();
        resolve();
      }
    }, 500);

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(pollTimer);
      clearTimeout(safetyTimer);
      c.removeEventListener("statechange", onStateChange);
      src.onended = null;
    }

    src.onended = () => {
      cleanup();
      diag(`■ ended · ctx=${c.state}`);
      if (current === src) current = null;
      resolve();
    };
    try {
      const startAt = Math.max(scheduleAt, c.currentTime + 0.02);
      src.start(startAt);
    } catch (err) {
      diag(`⚠️ source.start failed: ${(err as Error).message}`);
      resolve();
      return;
    }
    current = src;
    const prevHad = lastBuffer !== null;
    lastBuffer = buffer;
    if (!prevHad) for (const l of listeners) l(true);
    diag(`▶ started · duration=${buffer.duration.toFixed(2)}s · ctx=${c.state}`);
  });
}

export function replayLast(onEnded?: () => void) {
  if (!lastBuffer) return;
  const c = ensureCtx();
  if (c.state === "suspended") {
    c.resume().catch((e) => diag(`replay resume failed: ${(e as Error).message}`));
  }
  stopPlayback();
  const src = c.createBufferSource();
  src.buffer = lastBuffer;
  src.connect(masterGain ?? c.destination);
  src.onended = () => {
    if (current === src) current = null;
    onEnded?.();
  };
  src.start(c.currentTime + 0.05);
  current = src;
}

export function hasLastBuffer() {
  return lastBuffer !== null;
}

export function subscribeLastBuffer(fn: (has: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Keep-alive shims ────────────────────────────────────────────────────────
// The long-lived silent oscillator attached in unlockAudio() replaces the
// old start/stop keep-alive scheme. These are kept as no-ops so existing
// callers in VoiceCompanion don't need to change.
export function startKeepAlive(): void {
  if (!keepAliveOsc) {
    diag("startKeepAlive · noop (oscillator attaches on unlockAudio)");
  }
}

export function stopKeepAlive(): void {
  // Intentional noop — the silent oscillator must never stop.
}
