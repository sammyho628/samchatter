import { useEffect, useRef } from "react";

type Props = {
  getAnalyser: () => AnalyserNode | null;
  active: boolean;
  tint: "idle" | "listening" | "speaking";
};

const TINTS: Record<Props["tint"], string> = {
  idle: "rgba(255, 220, 180, 0.9)",
  listening: "rgba(120, 220, 255, 0.95)",
  speaking: "rgba(255, 180, 120, 0.95)",
};

export function WaveformOrb({ getAnalyser, active, tint }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = canvas.clientWidth;
      if (canvas.width !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      const analyser = getAnalyser();
      let level = 0;
      if (analyser) {
        const arr = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(arr);
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) {
          const v = (arr[i] - 128) / 128;
          sumSq += v * v;
        }
        level = Math.min(1, Math.sqrt(sumSq / arr.length) * 4);
      }
      // gentle idle breathing
      const t = performance.now() / 1000;
      const breath = (Math.sin(t * 1.6) + 1) / 2;
      const intensity = active ? Math.max(level, 0.15) : 0.1 + breath * 0.15;

      const cx = size / 2;
      const cy = size / 2;
      const baseR = size * 0.32;
      const r = baseR * (1 + intensity * 0.25);

      // outer glow
      const grad = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.8);
      grad.addColorStop(0, TINTS[tint]);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.8, 0, Math.PI * 2);
      ctx.fill();

      // waveform ring
      ctx.lineWidth = 4;
      ctx.strokeStyle = TINTS[tint];
      ctx.beginPath();
      const segments = 96;
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const wob =
          Math.sin(a * 6 + t * 3) * intensity * 12 +
          Math.sin(a * 3 - t * 2) * intensity * 8;
        const rr = r + wob;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [getAnalyser, active, tint]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    />
  );
}
