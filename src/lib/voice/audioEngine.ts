import { createWorkletBlobUrl } from "./pcm-worklet";

export type AudioEngineCallbacks = {
  onMicChunk: (pcm: ArrayBuffer) => void;
  onBargeIn?: () => void;
};

const PLAYBACK_RATE = 24000;
const CAPTURE_RATE = 16000;
const BARGE_IN_RMS = 0.08;
const BARGE_IN_FRAMES = 2;
// Larger initial jitter buffer to smooth out the first few chunks of a
// turn over flaky mobile networks. Trade-off: ~0.35s of latency before the
// AI's voice starts, but no underrun stutter.
const INITIAL_JITTER_SECONDS = 0.35;
// If we detect we've drifted behind mid-turn, pad by this much before
// resuming so we don't immediately underrun again.
const UNDERRUN_REPAIR_SECONDS = 0.18;
const OUTPUT_PLAYBACK_SPEED = 0.96;

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

  constructor(cbs: AudioEngineCallbacks) {
    this.cbs = cbs;
  }

  /**
   * MUST be called synchronously inside a user gesture (no awaits before this).
   * Creates and immediately resumes both AudioContexts to satisfy iOS Safari.
   */
  unlock() {
    const AC: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    this.captureCtx = new AC({ sampleRate: CAPTURE_RATE });
    this.playbackCtx = new AC({ sampleRate: PLAYBACK_RATE });
    // Fire-and-forget; resume() returns a promise but we don't need to await
    // inside the gesture — the call itself is what iOS requires.
    void this.captureCtx.resume();
    void this.playbackCtx.resume();

    this.playbackGain = this.playbackCtx.createGain();
    this.playbackAnalyser = this.playbackCtx.createAnalyser();
    this.playbackAnalyser.fftSize = 1024;
    this.playbackGain.connect(this.playbackAnalyser);
    this.playbackAnalyser.connect(this.playbackCtx.destination);
  }

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
      if (data?.type === "chunk") {
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
      }
    };
    this.micSource.connect(this.micAnalyser);
    this.micSource.connect(this.workletNode);
    // Worklet is a sink; don't connect to destination (would echo).
  }

  enqueuePcm(pcmBytes: Uint8Array) {
    const ctx = this.playbackCtx;
    if (!ctx || !this.playbackGain) return;
    const view = new DataView(
      pcmBytes.buffer,
      pcmBytes.byteOffset,
      pcmBytes.byteLength,
    );
    const sampleCount = Math.floor(pcmBytes.byteLength / 2);
    if (sampleCount === 0) return;
    const buf = ctx.createBuffer(1, sampleCount, PLAYBACK_RATE);
    const channel = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const s = view.getInt16(i * 2, true);
      channel[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = OUTPUT_PLAYBACK_SPEED;
    src.connect(this.playbackGain);
    const now = ctx.currentTime;
    // First chunk of a turn — pad with the larger initial jitter buffer.
    // Mid-turn underrun — pad with the smaller repair buffer so the gap
    // is short but we don't immediately stutter again.
    if (this.nextStartTime === 0) {
      this.nextStartTime = now + INITIAL_JITTER_SECONDS;
    } else if (this.nextStartTime < now) {
      this.nextStartTime = now + UNDERRUN_REPAIR_SECONDS;
    }
    const startAt = this.nextStartTime;
    src.start(startAt);
    this.nextStartTime = startAt + buf.duration / OUTPUT_PLAYBACK_SPEED;
    this.playing = true;
    this.playQueue.push(src);
    src.onended = () => {
      const idx = this.playQueue.indexOf(src);
      if (idx >= 0) this.playQueue.splice(idx, 1);
      if (this.playQueue.length === 0) {
        this.playing = false;
        this.nextStartTime = 0;
      }
    };
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
    this.nextStartTime = 0;
    this.playing = false;
    this.bargeInFrames = 0;
  }

  isPlaying() {
    return this.playing;
  }

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
    try {
      await this.captureCtx?.close();
    } catch {}
    try {
      await this.playbackCtx?.close();
    } catch {}
    this.captureCtx = null;
    this.playbackCtx = null;
    this.playbackGain = null;
    this.playbackAnalyser = null;
  }
}
