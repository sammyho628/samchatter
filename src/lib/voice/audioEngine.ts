import { createWorkletBlobUrl } from "./pcm-worklet";

export type AudioEngineCallbacks = {
  onMicChunk: (pcm: ArrayBuffer) => void;
  onBargeIn?: () => void;
  onDebug?: (msg: string) => void;
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  // Fired whenever a fully decoded AudioBuffer is about to play. Used by the
  // UI to enable a "🔁 Replay Voice" debug button so we can tell whether a
  // future stutter was network/decoding (replay sounds clean) or hardware
  // (replay still stutters).
  onBufferReady?: (buffer: AudioBuffer) => void;
};

const PLAYBACK_RATE = 24000;
const CAPTURE_RATE = 16000;
const PLAYER_BUFFER_SIZE = 2048;
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

  // Raw Linear PCM queue player. Incoming DashScope PCM16 chunks are converted
  // directly to Float32 samples and drained by one continuous audio callback.
  private audioQueue: number[] = [];
  private playerNode: ScriptProcessorNode | null = null;
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

    this.playerNode = this.playbackCtx.createScriptProcessor(PLAYER_BUFFER_SIZE, 0, 1);
    this.playerNode.onaudioprocess = (e) => {
      const outputBuffer = e.outputBuffer.getChannelData(0);
      let pulledSamples = false;

      for (let i = 0; i < PLAYER_BUFFER_SIZE; i++) {
        if (this.audioQueue.length > 0) {
          outputBuffer[i] = this.audioQueue.shift() ?? 0;
          pulledSamples = true;
        } else {
          outputBuffer[i] = 0;
        }
      }

      if (pulledSamples) {
        if (!this.playing) {
          this.playing = true;
          try { this.cbs.onPlaybackStart?.(); } catch {}
        }
      } else if (this.playing) {
        this.playing = false;
        this.micHoldUntil = performance.now() + INPUT_RESUME_AFTER_PLAYBACK_MS;
        try { this.cbs.onPlaybackEnd?.(); } catch {}
      }
    };
    this.playerNode.connect(this.playbackGain);
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

  enqueuePcm(pcmBytes: Uint8Array) {
    if (!this.playbackCtx || !this.playbackGain || pcmBytes.byteLength < 2) return;
    const alignedLength = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
    const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, alignedLength);
    const sampleCount = alignedLength / 2;
    for (let i = 0; i < sampleCount; i++) {
      this.audioQueue.push(view.getInt16(i * 2, true) / 32768.0);
    }
    // Don't flip `playing` here — let the audio callback flip it so the
    // onPlaybackStart/End callbacks fire from a single source of truth.
  }

  /**
   * Walkie-talkie playback: take an already-merged PCM16 LE buffer and play it
   * as a single AudioBufferSource. Eliminates ScriptProcessor scheduling jitter
   * that plagued the per-sample queue path. Use this for Qwen's merged
   * end-of-turn flush. `sampleRate` defaults to 24000 (Qwen omni output).
   */
  playWalkieTalkieBuffer(pcmBytes: Uint8Array, sampleRate = 24000) {
    if (!this.playbackCtx || !this.playbackGain || pcmBytes.byteLength < 2) return;
    const alignedLength = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
    // Copy into a fresh ArrayBuffer so Int16Array alignment is guaranteed.
    const copy = new Uint8Array(alignedLength);
    copy.set(pcmBytes.subarray(0, alignedLength));
    const int16 = new Int16Array(copy.buffer, 0, alignedLength / 2);
    const audioBuffer = this.playbackCtx.createBuffer(1, int16.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768;
    const src = this.playbackCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.playbackGain);
    // Manually drive the playback lifecycle callbacks for the single-buffer path.
    this.playing = true;
    try { this.cbs.onPlaybackStart?.(); } catch {}
    src.onended = () => {
      this.playing = false;
      this.micHoldUntil = performance.now() + INPUT_RESUME_AFTER_PLAYBACK_MS;
      try { this.cbs.onPlaybackEnd?.(); } catch {}
    };
    src.start(0);
  }

  /** Kill switch — instantly wipes queued raw samples. */
  stopPlayback(opts: { holdMic?: boolean } = {}) {
    this.audioQueue = [];
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
    try { this.playerNode?.disconnect(); } catch {}
    this.playerNode = null;
    this.audioQueue = [];
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
