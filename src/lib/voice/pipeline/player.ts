// Single shared AudioContext + decodeAudioData. No PCM math, no chunk math.
// stop() before each start kills overlap → never two voices at once.
let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;
let lastBuffer: AudioBuffer | null = null;
const listeners = new Set<(has: boolean) => void>();

// Diagnostic logger — subscribed by the UI so audio failures show up in the
// in-app debug panel, not just devtools. Always also mirrors to console so
// hard-refresh / mobile users can see the trail in Safari's web inspector.
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

function getCtx(): AudioContext {
  if (ctx && ctx.state !== "closed") return ctx;
  const AC: typeof AudioContext =
    (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx = new AC();
  diag(`AudioContext created · state=${ctx.state} · sampleRate=${ctx.sampleRate}`);
  return ctx;
}

/** Call once inside a user gesture (pointerdown) so iOS Safari unlocks audio.
 *  Resuming alone is NOT enough on iOS — we must also play a real (silent)
 *  buffer synchronously inside the gesture, otherwise scheduled audio stays
 *  queued until the user backgrounds and foregrounds the tab. */
export async function unlockAudio(): Promise<void> {
  const c = getCtx();
  const before = c.state;
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
      await c.resume();
    } catch (err) {
      const e = err as Error;
      if (e.name === "NotAllowedError" || /autoplay/i.test(e.message)) {
        diag(`⚠️ autoplay blocked — resume() rejected (${e.message}). Need a real user gesture.`);
      } else {
        diag(`⚠️ AudioContext resume failed: ${e.message}`);
      }
    }
  }
  diag(`unlockAudio · ${before} → ${c.state}`);
}

// Resume the context when the page returns to foreground — iOS Safari
// suspends background AudioContexts and pending playback would otherwise
// stay silent until another user gesture.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx && ctx.state === "suspended") {
      ctx.resume().then(
        () => diag("visibility resume ok"),
        (e) => diag(`visibility resume failed: ${(e as Error).message}`),
      );
    }
  });

  // Belt-and-suspenders: any pointer/touch/key gesture resumes a suspended
  // context. Browsers (esp. Safari iOS, Chrome autoplay policy) sometimes
  // re-suspend the context after a hard refresh or tab switch; without this
  // the first synthesized TTS chunk plays silently.
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
      current.onended = null;
      current.stop();
      current.disconnect();
    } catch {
      /* ignore */
    }
    current = null;
  }
}

/** Play an audio clip. Resolves when playback ends (or is stopped). */
export async function playBase64Audio(audioBase64: string): Promise<void> {
  const c = getCtx();
  if (c.state === "suspended") {
    diag("playBase64Audio · context suspended, attempting resume");
    try {
      await c.resume();
    } catch (err) {
      const e = err as Error;
      if (e.name === "NotAllowedError" || /autoplay/i.test(e.message)) {
        diag(`⚠️ autoplay blocked at play time (${e.message}). Audio will be silent — user must tap to enable.`);
      } else {
        diag(`⚠️ resume failed at play time: ${e.message}`);
      }
    }
    if ((c.state as string) !== "running") {
      diag(`⚠️ context still ${c.state} after resume — playback will likely be silent.`);
    }
  }
  const bytes = Uint8Array.from(atob(audioBase64), (ch) => ch.charCodeAt(0));
  const ab = bytes.buffer.slice(0) as ArrayBuffer;
  diag(`playBase64Audio · ctx=${c.state} · inputBytes=${bytes.length}`);
  let buffer: AudioBuffer;
  try {
    buffer = await c.decodeAudioData(ab);
  } catch (err) {
    diag(`⚠️ decodeAudioData failed: ${(err as Error).message}`);
    throw err;
  }
  stopPlayback();
  return new Promise<void>((resolve) => {
    const src = c.createBufferSource();
    src.buffer = buffer;
    try {
      src.connect(c.destination);
    } catch (err) {
      diag(`⚠️ audio node disconnected: ${(err as Error).message}`);
      resolve();
      return;
    }
    src.onended = () => {
      if (current === src) current = null;
      resolve();
    };
    try {
      src.start(c.currentTime + 0.05);
    } catch (err) {
      diag(`⚠️ source.start failed: ${(err as Error).message}`);
      resolve();
      return;
    }
    current = src;
    const prevHad = lastBuffer !== null;
    lastBuffer = buffer;
    if (!prevHad) for (const l of listeners) l(true);
    diag(`▶ playing ${buffer.duration.toFixed(2)}s · ctx=${c.state}`);
  });
}

export function replayLast(onEnded?: () => void) {
  if (!lastBuffer) return;
  const c = getCtx();
  if (c.state === "suspended") {
    c.resume().catch((e) => diag(`replay resume failed: ${(e as Error).message}`));
  }
  stopPlayback();
  const src = c.createBufferSource();
  src.buffer = lastBuffer;
  src.connect(c.destination);
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
