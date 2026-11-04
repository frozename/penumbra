const WILSON_Z = 1.959964;

type Interval = { lo: number; hi: number };

type Cluster = { s: number; n: number };

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wilson(s: number, n: number): Interval | null {
  if (n === 0) {
    return null;
  }
  const z = WILSON_Z;
  const p = s / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

function manskiBounds(s: number, f: number, u: number): Interval | null {
  const total = s + f + u;
  if (total === 0) {
    return null;
  }
  return { lo: s / total, hi: (s + u) / total };
}

function percentileAt(sorted: readonly number[], index: number): number {
  const value = sorted[index];
  if (value === undefined) {
    throw new RangeError("bootstrap percentile index out of range");
  }
  return value;
}

function replicateRatio(clusters: readonly Cluster[], rng: () => number): number | null {
  const k = clusters.length;
  let s = 0;
  let n = 0;
  for (let i = 0; i < k; i += 1) {
    const drawn = clusters[Math.floor(rng() * k)];
    if (drawn === undefined) {
      continue;
    }
    s += drawn.s;
    n += drawn.n;
  }
  return n === 0 ? null : s / n;
}

function clusterBootstrap(
  clusters: readonly Cluster[],
  opts: { seed: number; B: number },
): Interval | null {
  let totalN = 0;
  for (const cluster of clusters) {
    totalN += cluster.n;
  }
  if (clusters.length === 0 || totalN === 0) {
    return null;
  }
  const rng = mulberry32(opts.seed);
  const values: number[] = [];
  for (let b = 0; b < opts.B; b += 1) {
    const ratio = replicateRatio(clusters, rng);
    if (ratio !== null) {
      values.push(ratio);
    }
  }
  if (values.length === 0) {
    return null;
  }
  values.sort((lhs, rhs) => lhs - rhs);
  const m = values.length;
  return {
    lo: percentileAt(values, Math.floor(0.025 * (m - 1))),
    hi: percentileAt(values, Math.ceil(0.975 * (m - 1))),
  };
}

export { type Cluster, clusterBootstrap, type Interval, manskiBounds, mulberry32, wilson };
