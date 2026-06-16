import { createWorkletBlobUrl } from "./pcm-worklet";

export type AudioEngineCallbacks = {
  onMicChunk: (pcm: ArrayBuffer) => void;
  onBargeIn?: () => void;
  onDebug?: (msg: string) => void;
};

const PLAYBACK_RATE = 24000;
const CAPTURE_RATE = 16000;
// Shock-absorber lead time when the playback clock has fallen behind.
const SCHEDULER_LEAD = 0.05;
// Barge-in: only trigger on sustained loud speech so background chatter
// does NOT interrupt the assistant.
const BARGE_IN_RMS = 0.28;
const BARGE_IN_FRAMES = 15;
// Keep mic closed briefly after assistant playback to avoid speaker echo
// being re-captured and treated as the user starting to talk.
const INPUT_RESUME_AFTER_PLAYBACK_MS = 500;

export class AudioEngine {
  captureCtx: AudioContext | null = null;
  playbackCtx: AudioContext | null = null;
  micStream: MediaStream | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  workletNode: AudioWorkletNode | null = null;
  micAnalyser: AnalyserNode | null = null;
  playbackAnalyser: AnalyserNode | null = null;

  // Active scheduled source nodes — used by the kill switch.
  private activeNodes: AudioBufferSourceNode[] = [];
  private nextPlayTime = 0;
  private playing = false;
  private playbackGain: GainNode | null = null;
  private bargeInFrames = 0;
  private cbs: AudioEngineCallbacks;

  private muted = false;
  private micMuted = false;
  private micHoldUntil = 0;
  private lastHoldDebugAt = 0;

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
        sampleRate: 16000,
        channelCount: 1,
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
          this.stopPlayback({ holdMic: false });
          this.cbs.onBargeIn?.();
          this.cbs.onMicChunk(data.pcm as ArrayBuffer);
        }
      } else {
        const now = performance.now();
        if (now < this.micHoldUntil) {
          this.bargeInFrames = 0;
          if (now - this.lastHoldDebugAt > 1000) {
            this.lastHoldDebugAt = now;
            this.cbs.onDebug?.("mic held briefly to avoid speaker echo");
          }
          return;
        }
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

  enqueuePcm(pcmBytes: Uint8Array) {
    const ctx = this.playbackCtx;
    if (!ctx || !this.playbackGain) return;
    const buf = this.decodePcm(pcmBytes);
    if (!buf) return;

    // nextPlayTime strategy with shock-absorber buffer.
    if (this.nextPlayTime < ctx.currentTime) {
      this.nextPlayTime = ctx.currentTime + SCHEDULER_LEAD;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playbackGain);
    src.start(this.nextPlayTime);
    this.activeNodes.push(src);
    this.nextPlayTime += buf.duration;
    this.playing = true;
    src.onended = () => {
      const idx = this.activeNodes.indexOf(src);
      if (idx >= 0) this.activeNodes.splice(idx, 1);
      try { src.disconnect(); } catch {}
      if (this.activeNodes.length === 0) {
        this.playing = false;
        this.nextPlayTime = 0;
        this.micHoldUntil = performance.now() + INPUT_RESUME_AFTER_PLAYBACK_MS;
      }
    };
  }

  /** Kill switch — instantly stops every queued/playing chunk. */
  stopPlayback(opts: { holdMic?: boolean } = {}) {
    for (const node of this.activeNodes) {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch {}
    }
    this.activeNodes = [];
    this.nextPlayTime = 0;
    this.playing = false;
    if (opts.holdMic !== false) {
      this.micHoldUntil = performance.now() + INPUT_RESUME_AFTER_PLAYBACK_MS;
    }
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
