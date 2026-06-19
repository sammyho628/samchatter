// Single shared AudioContext + decodeAudioData. No PCM math, no chunk math.
// stop() before each start kills overlap → never two voices at once.
let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;
let lastBuffer: AudioBuffer | null = null;
const listeners = new Set<(has: boolean) => void>();

function getCtx(): AudioContext {
  if (ctx && ctx.state !== "closed") return ctx;
  const AC: typeof AudioContext =
    (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx = new AC();
  return ctx;
}

/** Call once inside a user gesture (pointerdown) so iOS Safari unlocks audio. */
export async function unlockAudio(): Promise<void> {
  const c = getCtx();
  if (c.state === "suspended") await c.resume().catch(() => {});
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
  if (c.state === "suspended") await c.resume().catch(() => {});
  const bytes = Uint8Array.from(atob(audioBase64), (ch) => ch.charCodeAt(0));
  const ab = bytes.buffer.slice(0) as ArrayBuffer;
  const buffer = await c.decodeAudioData(ab);
  stopPlayback();
  return new Promise<void>((resolve) => {
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    src.onended = () => {
      if (current === src) current = null;
      resolve();
    };
    src.start(c.currentTime + 0.05);
    current = src;
    const prevHad = lastBuffer !== null;
    lastBuffer = buffer;
    if (!prevHad) for (const l of listeners) l(true);
  });
}

export function replayLast(onEnded?: () => void) {
  if (!lastBuffer) return;
  const c = getCtx();
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
