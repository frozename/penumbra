import { useMemo } from "react";

function seedRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export interface SparklineProps {
  seed?: number;
  color?: string;
  points?: number;
  height?: number;
  fillOpacity?: number;
}

export function Sparkline({
  seed = 1,
  color = "var(--color-brand)",
  points = 28,
  height = 28,
  fillOpacity = 0.18,
}: SparklineProps): JSX.Element {
  const values = useMemo(() => {
    const rand = seedRand(seed);
    const arr: number[] = [];
    for (let i = 0; i < points; i += 1) {
      const base = 0.45 + Math.sin(i * 0.6 + seed) * 0.18;
      arr.push(Math.max(0.05, Math.min(0.95, base + (rand() - 0.5) * 0.4)));
    }
    return arr;
  }, [seed, points]);

  const w = 100;
  const h = 100;
  const step = w / (points - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(h - v * h).toFixed(2)}`).join(" ");
  const fill = `0,${h} ${pts} ${w},${h}`;

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height }}>
      <polygon points={fill} fill={color} opacity={fillOpacity} />
      <polyline
        points={pts}
        stroke={color}
        strokeWidth="1.4"
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
