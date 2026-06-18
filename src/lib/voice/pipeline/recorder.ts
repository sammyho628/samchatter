// Push-to-talk MediaRecorder wrapper. start() / stop() → Blob.
export type RecorderHandle = {
  stop: () => Promise<{ blob: Blob; mimeType: string }>;
  cancel: () => void;
};

const CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  for (const t of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "audio/webm";
}

export async function startRecording(): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();

  const cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
  };

  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          cleanup();
          const blob = new Blob(chunks, { type: mimeType });
          resolve({ blob, mimeType });
        };
        try {
          recorder.stop();
        } catch {
          cleanup();
          resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType });
        }
      }),
    cancel: () => {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      cleanup();
    },
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
