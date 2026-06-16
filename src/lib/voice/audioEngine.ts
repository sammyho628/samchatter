import { createWorkletBlobUrl } from "./pcm-worklet";

export type AudioEngineCallbacks = {
  onMicChunk: (pcm: ArrayBuffer) => void;
  onBargeIn?: () => void;
  onDebug?: (msg: string) => void;
};

const PLAYBACK_RATE = 24000;
const CAPTURE_RATE = 16000;
// Much higher threshold + more sustained frames so background chatter,
// TV, or someone else talking in the room does NOT trigger barge-in.
const BARGE_IN_RMS = 0.18;
const BARGE_IN_FRAMES = 5;

// Pre-buffer strategy:
// Hold back the first chunks of every turn until we have at least this
// many seconds of audio queued, THEN start playing. This eliminates the
// "stutter when the AI says my name" jitter at the start of a reply,
// because the playback clock never starts on an empty queue.
const PRELOAD_SECONDS = 0.7;
// Hard ceiling so we don't wait forever if the model only sends one tiny chunk.
const PRELOAD_MAX_MS = 900;
// If we drift behind mid-turn (network hiccup), pad by this much before
// resuming so we don't immediately underrun again.
const UNDERRUN_REPAIR_SECONDS = 0.25;

export class AudioEngine {
  captureCtx: AudioContext | null = null;
  playbackCtx: AudioContext | null = null;
  micStream: MediaStream | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  workletNode: AudioWorkletNode | null = null;
  micAnalyser: AnalyserNode | null = null;
  playbackAnalyser: AnalyserNode | null = null;

  private playQueue: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  private playing = false;
  private playbackGain: GainNode | null = null;
  private bargeInFrames = 0;
  private cbs: AudioEngineCallbacks;

  // Pre-roll buffer for the start of each turn.
  private preroll: AudioBuffer[] = [];
  private prerollSeconds = 0;
  private prerollStartedAt = 0;
  private prerollTimer: number | null = null;
  private inTurn = false;

  constructor(cbs: AudioEngineCallbacks) {
    this.cbs = cbs;
  }

  unlock() {
    const AC: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    this.captureCtx = new AC({ sampleRate: CAPTURE_RATE });
    this.playbackCtx = new AC({ sampleRate: PLAYBACK_RATE });
    void this.captureCtx.resume();
    void this.playbackCtx.resume();

    this.playbackGain = this.playbackCtx.createGain();
    this.playbackGain.gain.value = this.muted ? 0 : 1;
    this.playbackAnalyser = this.playbackCtx.createAnalyser();
    this.playbackAnalyser.fftSize = 1024;
    this.playbackGain.connect(this.playbackAnalyser);
    this.playbackAnalyser.connect(this.playbackCtx.destination);
  }

  private muted = false;
  private micMuted = false;

  setMuted(muted: boolean) {
    this.muted = muted;
    const g = this.playbackGain;
    if (!g) return;
    const ctx = this.playbackCtx!;
    g.gain.cancelScheduledValues(ctx.currentTime);
    g.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.015);
  }
  isMuted() { return this.muted; }

  setMicMuted(muted: boolean) {
    this.micMuted = muted;
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.enabled = !muted;
    }
    this.bargeInFrames = 0;
  }
  isMicMuted() { return this.micMuted; }

  async startMic() {
    if (!this.captureCtx) throw new Error("AudioEngine not unlocked");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.micStream = stream;

    const workletUrl = createWorkletBlobUrl();
    await this.captureCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    this.micSource = this.captureCtx.createMediaStreamSource(stream);
    this.micAnalyser = this.captureCtx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.workletNode = new AudioWorkletNode(this.captureCtx, "pcm-capture");
    this.workletNode.port.onmessage = (ev) => {
      const data = ev.data;
      if (data?.type !== "chunk") return;
      if (this.micMuted) {
        this.bargeInFrames = 0;
        return;
      }
      if (this.playing && typeof data.rms === "number") {
        this.bargeInFrames = data.rms > BARGE_IN_RMS ? this.bargeInFrames + 1 : 0;
        if (this.bargeInFrames >= BARGE_IN_FRAMES) {
          this.stopPlayback();
          this.cbs.onBargeIn?.();
          this.cbs.onMicChunk(data.pcm as ArrayBuffer);
        }
      } else {
        this.bargeInFrames = 0;
        this.cbs.onMicChunk(data.pcm as ArrayBuffer);
      }
    };
    this.micSource.connect(this.micAnalyser);
    this.micSource.connect(this.workletNode);
  }

  private decodePcm(pcmBytes: Uint8Array): AudioBuffer | null {
    const ctx = this.playbackCtx;
    if (!ctx) return null;
    const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
    const sampleCount = Math.floor(pcmBytes.byteLength / 2);
    if (sampleCount === 0) return null;
    const buf = ctx.createBuffer(1, sampleCount, PLAYBACK_RATE);
    const channel = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const s = view.getInt16(i * 2, true);
      channel[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    return buf;
  }

  private scheduleBuffer(buf: AudioBuffer) {
    const ctx = this.playbackCtx;
    if (!ctx || !this.playbackGain) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playbackGain);
    const now = ctx.currentTime;
    if (this.nextStartTime < now) {
      // Underrun mid-turn — pad slightly before resuming.
      this.nextStartTime = now + UNDERRUN_REPAIR_SECONDS;
      this.cbs.onDebug?.(`audio underrun, padded ${UNDERRUN_REPAIR_SECONDS}s`);
    }
    src.start(this.nextStartTime);
    this.nextStartTime += buf.duration;
    this.playing = true;
    this.playQueue.push(src);
    src.onended = () => {
      const idx = this.playQueue.indexOf(src);
      if (idx >= 0) this.playQueue.splice(idx, 1);
      if (this.playQueue.length === 0 && this.preroll.length === 0) {
        this.playing = false;
        this.nextStartTime = 0;
        this.inTurn = false;
      }
    };
  }

  private flushPreroll() {
    if (this.prerollTimer !== null) {
      window.clearTimeout(this.prerollTimer);
      this.prerollTimer = null;
    }
    const ctx = this.playbackCtx;
    if (!ctx) return;
    // Start playback clock with a tiny lead time.
    this.nextStartTime = ctx.currentTime + 0.05;
    const buffered = this.prerollSeconds;
    const queued = this.preroll.length;
    for (const buf of this.preroll) this.scheduleBuffer(buf);
    this.preroll = [];
    this.prerollSeconds = 0;
    this.cbs.onDebug?.(`▶ playback start (${queued} chunks, ${buffered.toFixed(2)}s buffered)`);
  }

  enqueuePcm(pcmBytes: Uint8Array) {
    const ctx = this.playbackCtx;
    if (!ctx) return;
    const buf = this.decodePcm(pcmBytes);
    if (!buf) return;

    if (!this.inTurn) {
      // New turn — start collecting pre-roll.
      this.inTurn = true;
      this.preroll = [];
      this.prerollSeconds = 0;
      this.prerollStartedAt = performance.now();
      this.cbs.onDebug?.("◌ buffering reply…");
    }

    if (this.preroll.length > 0 || this.nextStartTime === 0) {
      // Still buffering this turn's preroll.
      this.preroll.push(buf);
      this.prerollSeconds += buf.duration;
      const elapsed = performance.now() - this.prerollStartedAt;
      if (this.prerollSeconds >= PRELOAD_SECONDS || elapsed >= PRELOAD_MAX_MS) {
        this.flushPreroll();
      } else if (this.prerollTimer === null) {
        // Safety net — flush at max wait.
        this.prerollTimer = window.setTimeout(
          () => this.flushPreroll(),
          PRELOAD_MAX_MS - elapsed,
        );
      }
      return;
    }

    // Mid-turn, normal path.
    this.scheduleBuffer(buf);
  }

  stopPlayback() {
    for (const src of this.playQueue) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {}
    }
    this.playQueue = [];
    if (this.prerollTimer !== null) {
      window.clearTimeout(this.prerollTimer);
      this.prerollTimer = null;
    }
    this.preroll = [];
    this.prerollSeconds = 0;
    this.nextStartTime = 0;
    this.playing = false;
    this.inTurn = false;
    this.bargeInFrames = 0;
  }

  isPlaying() { return this.playing; }

  async stop() {
    this.stopPlayback();
    try {
      this.workletNode?.disconnect();
      this.micSource?.disconnect();
      this.micAnalyser?.disconnect();
    } catch {}
    this.workletNode = null;
    this.micSource = null;
    this.micAnalyser = null;
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    try { await this.captureCtx?.close(); } catch {}
    try { await this.playbackCtx?.close(); } catch {}
    this.captureCtx = null;
    this.playbackCtx = null;
    this.playbackGain = null;
    this.playbackAnalyser = null;
  }
}
