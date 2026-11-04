import { beforeAll, expect, test } from "bun:test";

// Input and output shapes are declared locally: stats.ts does not exist at the
// base, so no value or type may be imported from it.
type Interval = { lo: number; hi: number };
type Cluster = { s: number; n: number };
type Mulberry32Fn = (seed: number) => () => number;
type WilsonFn = (s: number, n: number) => Interval | null;
type ManskiBoundsFn = (s: number, f: number, u: number) => Interval | null;
type ClusterBootstrapFn = (
  clusters: readonly Cluster[],
  opts: { seed: number; B: number },
) => Interval | null;

const MOD_URL = new URL("../../src/evals/stats.ts", import.meta.url).href;

async function load(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(MOD_URL)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let mod: Record<string, unknown> | null = null;

beforeAll(async () => {
  mod = await load();
});

const mulberry32 = (): Mulberry32Fn => mod?.["mulberry32"] as Mulberry32Fn;
const wilson = (): WilsonFn => mod?.["wilson"] as WilsonFn;
const manskiBounds = (): ManskiBoundsFn => mod?.["manskiBounds"] as ManskiBoundsFn;
const clusterBootstrap = (): ClusterBootstrapFn => mod?.["clusterBootstrap"] as ClusterBootstrapFn;

test("P5-1: mulberry32 is a deterministic seeded generator", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const rng = mulberry32()(42);
  expect(rng()).toBeCloseTo(0.6011037519201636, 15);
  expect(rng()).toBeCloseTo(0.44829055899754167, 15);
  expect(rng()).toBeCloseTo(0.8524657934904099, 15);
  const lhs = mulberry32()(7);
  const rhs = mulberry32()(7);
  const seqLhs = Array.from({ length: 8 }, (): number => lhs());
  const seqRhs = Array.from({ length: 8 }, (): number => rhs());
  expect(seqLhs).toEqual(seqRhs);
});

test("P5-2: wilson uses the 95% score interval with edge clamps", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const mid = wilson()(5, 10);
  expect(mid).not.toBeNull();
  expect(mid?.lo).toBeCloseTo(0.23659308901147935, 12);
  expect(mid?.hi).toBeCloseTo(0.7634069109885206, 12);
  expect(wilson()(0, 0)).toBeNull();
  expect(wilson()(0, 10)?.lo).toBe(0);
  expect(wilson()(10, 10)?.hi).toBeLessThanOrEqual(1);
});

test("P5-3: manskiBounds brackets the solve rate when outcomes are unknown", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expect(manskiBounds()(2, 3, 5)).toEqual({ lo: 0.2, hi: 0.7 });
  expect(manskiBounds()(4, 0, 0)).toEqual({ lo: 1, hi: 1 });
  expect(manskiBounds()(0, 0, 0)).toBeNull();
});

test("P5-4: clusterBootstrap resamples whole families, not pooled rows", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const clusters: Cluster[] = [
    ...Array.from({ length: 5 }, (): Cluster => ({ s: 3, n: 3 })),
    ...Array.from({ length: 5 }, (): Cluster => ({ s: 0, n: 3 })),
  ];
  const ci = clusterBootstrap()(clusters, { seed: 7, B: 2000 });
  const pooled = wilson()(15, 30);
  expect(ci).not.toBeNull();
  expect(pooled).not.toBeNull();
  if (ci === null || pooled === null) {
    return;
  }
  expect(ci.hi - ci.lo).toBeGreaterThan(pooled.hi - pooled.lo + 0.1);
  const again = clusterBootstrap()(clusters, { seed: 7, B: 2000 });
  expect(JSON.stringify(again)).toBe(JSON.stringify(ci));
  expect(clusterBootstrap()([], { seed: 1, B: 10 })).toBeNull();
});
