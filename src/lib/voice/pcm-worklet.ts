// AudioWorklet processor source. Loaded into the AudioContext at runtime
// via a Blob URL so it works without a separate static asset.
//
// - Captures mono Float32 audio at the AudioContext sample rate (16kHz).
// - Buffers ~40ms chunks (640 samples) so server VAD receives speech promptly.
// - Converts to 16-bit little-endian PCM.
// - Posts { type: 'chunk', pcm: ArrayBuffer, rms: number } to the main thread.

export const PCM_WORKLET_SOURCE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(640);
    this._w = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._w++] = ch[i];
      if (this._w >= this._buf.length) {
        const pcm = new ArrayBuffer(this._buf.length * 2);
        const view = new DataView(pcm);
        let sumSq = 0;
        for (let j = 0; j < this._buf.length; j++) {
          let s = this._buf[j];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          sumSq += s * s;
          view.setInt16(j * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        const rms = Math.sqrt(sumSq / this._buf.length);
        this.port.postMessage({ type: 'chunk', pcm, rms }, [pcm]);
        this._w = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCaptureProcessor);
`;

export function createWorkletBlobUrl(): string {
  const blob = new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}
