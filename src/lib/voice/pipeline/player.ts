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
  if (ctx && ctx.state !== "closed" && (ctx.state as string) !== "interrupted") return ctx;
  if (ctx) {
    try { void ctx.close(); } catch { /* ignore */ }
    ctx = null;
  }
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
  if ((c.state as string) === "interrupted") {
    diag(`⚠️ AudioContext interrupted (iOS lock/call) — recreating context`);
    try { void c.close(); } catch { /* ignore */ }
    ctx = null;
    return unlockAudio();
  }
  diag(`unlockAudio · ${before} → ${c.state}`);
}

// Resume the context when the page returns to foreground — iOS Safari
// suspends background AudioContexts and pending playback would otherwise
// stay silent until another user gesture.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx) {
      if (ctx.state === "suspended") {
        ctx.resume().then(
          () => diag("visibility resume ok"),
          (e) => diag(`visibility resume failed: ${(e as Error).message}`),
        );
      } else if ((ctx.state as string) === "interrupted") {
        diag("visibility: interrupted context — will recreate on next use");
        try { void ctx.close(); } catch { /* ignore */ }
        ctx = null;
      }
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
      // Do NOT null onended — let stop() fire it naturally so any
      // pending playBase64Audio promise resolves and the orchestrator
      // loop can continue. Nulling it here causes textBusy to get stuck.
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
  // Capture the schedule time BEFORE the async decode so it isn't stale
  const scheduleAt = c.currentTime + 0.1;
  let buffer: AudioBuffer;
  try {
    buffer = await c.decodeAudioData(ab);
  } catch (err) {
    diag(`⚠️ decodeAudioData failed: ${(err as Error).message}`);
    throw err;
  }
  // Context may have suspended during the async decodeAudioData call above.
  // If so, try to resume it now before scheduling playback.
  if (c.state === "suspended") {
    diag("playBase64Audio · ctx suspended post-decode — attempting resume");
    try { await c.resume(); } catch { /* will be handled by statechange listener */ }
  }
  stopPlayback();
  return new Promise<void>((resolve) => {
    // Guard against cleanup() being called twice (safety timer + stateChange racing).
    let cleaned = false;
    const src = c.createBufferSource();
    src.buffer = buffer;
    try {
      src.connect(c.destination);
    } catch (err) {
      diag(`⚠️ audio node disconnected: ${(err as Error).message}`);
      resolve();
      return;
    }
    // If the AudioContext gets interrupted mid-playback (iOS phone lock,
    // incoming call, Siri, route change), try ctx.resume() first. If resume
    // succeeds but onended still doesn't fire within 2s, force-resolve so the
    // next AI response isn't blocked for 15+ seconds.
    const onStateChange = () => {
      if (c.state === "closed") {
        cleanup();
        diag(`⚠️ ctx closed during playback — force resolve`);
        resolve();
        return;
      }
      if ((c.state as string) === "interrupted" || c.state === "suspended") {
        diag(`⚠️ ctx ${c.state} mid-playback — attempting auto-resume`);
        c.resume().then(
          () => {
            diag(`✓ ctx resume() resolved · state=${c.state}`);
            // On iOS, resume() often resolves without throwing even when there
            // is no user gesture, but the AudioContext stays suspended/interrupted
            // and onended never fires. Give audio 2 seconds to prove it's
            // actually playing; if it hasn't fired onended by then, force-resolve.
            setTimeout(() => {
              if (cleaned) return; // onended already fired — all good
              diag(`⚠️ onended silent 2s after resume · ctx=${c.state} — force resolve`);
              cleanup();
              try { void c.close(); } catch { /* ignore */ }
              if (ctx === c) ctx = null;
              resolve();
            }, 2000);
          },
          (e) => {
            diag(`⚠️ auto-resume failed: ${(e as Error).message} — force resolve`);
            cleanup();
            resolve();
          },
        );
      }
    };
    c.addEventListener("statechange", onStateChange);

    // Safety timer: fallback if onended AND statechange both fail to fire.
    // 15s buffer covers slow decode on desktop without blocking mobile for 30s.
    const safetyMs = Math.ceil((buffer.duration + 15) * 1000);
    const safetyTimer = setTimeout(() => {
      cleanup();
      diag(`⚠️ playback safety timeout after ${(buffer.duration + 15).toFixed(1)}s · ctx=${c.state} — force resolve + recreate ctx`);
      // Nuke the wedged context so the next utterance starts on a fresh one
      // instead of inheriting the stuck state.
      try { void c.close(); } catch { /* ignore */ }
      if (ctx === c) ctx = null;
      resolve();
    }, safetyMs);

    function cleanup() {
      if (cleaned) return;   // idempotent: safe to call from multiple code paths
      cleaned = true;
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
      // Use max so we never schedule in the past if decode was slow
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
