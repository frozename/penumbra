import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BundledEmbedder } from "../../src/embedder/bundled.js";

export interface EmbedRecipeRow {
  id: string;
  title: string;
  body: string;
}

export interface EmbedRecipeFixtures {
  weakRows: EmbedRecipeRow[];
  goldenRows: EmbedRecipeRow[];
  corpusRows: EmbedRecipeRow[];
  queries: string[];
}

interface CombinedFixtureFile extends EmbedRecipeFixtures {}

export type CandidateKey =
  | "minilm_body_only"
  | "minilm_title_only"
  | "minilm_title_plus_concise"
  | "bge_small_title_only"
  | "bge_base_title_only";

export interface CandidateScore {
  key: CandidateKey;
  model: string;
  dim: number;
  representation: "body_only" | "title_only" | "title_plus_concise";
  migrationNeeded: boolean;
  runnable: boolean;
  weakLift: number | null;
  regressionCount: number | null;
  weakEntered: number | null;
  baselineWeakEntered: number | null;
  baselineGoldenEntered: number | null;
  goldenEntered: number | null;
  error?: string;
}

export interface RecipeDecision {
  candidateKey: CandidateKey;
  selectedAt: string;
  note?: string;
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "t2-embed-recipe");
const DECISION_PATH = resolve(import.meta.dir, "../../../../scripts/recipe-decision.json");
const REPO_ROOT = resolve(import.meta.dir, "../../../../");
const FASTEMBED_CACHE_DIR = join(REPO_ROOT, "packages/core/local_cache");

const CANDIDATES: Record<
  CandidateKey,
  {
    key: CandidateKey;
    model: string;
    dim: number;
    representation: "body_only" | "title_only" | "title_plus_concise";
    migrationNeeded: boolean;
    embedder: "minilm" | "bge-small" | "bge-base";
  }
> = {
  minilm_body_only: {
    key: "minilm_body_only",
    model: "AllMiniLML6V2",
    dim: 384,
    representation: "body_only",
    migrationNeeded: false,
    embedder: "minilm",
  },
  minilm_title_only: {
    key: "minilm_title_only",
    model: "AllMiniLML6V2",
    dim: 384,
    representation: "title_only",
    migrationNeeded: false,
    embedder: "minilm",
  },
  minilm_title_plus_concise: {
    key: "minilm_title_plus_concise",
    model: "AllMiniLML6V2",
    dim: 384,
    representation: "title_plus_concise",
    migrationNeeded: false,
    embedder: "minilm",
  },
  bge_small_title_only: {
    key: "bge_small_title_only",
    model: "BAAI/bge-small-en-v1.5",
    dim: 384,
    representation: "title_only",
    migrationNeeded: false,
    embedder: "bge-small",
  },
  bge_base_title_only: {
    key: "bge_base_title_only",
    model: "BAAI/bge-base-en-v1.5",
    dim: 768,
    representation: "title_only",
    migrationNeeded: true,
    embedder: "bge-base",
  },
};

interface EmbedderLike {
  embed(texts: string[]): Promise<Float32Array[]>;
}

const embedderCache = new Map<string, EmbedderLike>();

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function representationText(representation: "body_only" | "title_only" | "title_plus_concise", row: EmbedRecipeRow): string {
  switch (representation) {
    case "body_only":
      return row.body;
    case "title_only":
      return row.title;
    case "title_plus_concise":
      return `${row.title}\n\n${row.body.slice(0, 256)}`;
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let out = 0;
  for (let i = 0; i < n; i += 1) out += a[i]! * b[i]!;
  return out;
}

function uniqueRows(rows: EmbedRecipeRow[]): EmbedRecipeRow[] {
  const map = new Map<string, EmbedRecipeRow>();
  for (const row of rows) map.set(row.id, row);
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function getEmbedder(kind: "minilm" | "bge-small" | "bge-base"): Promise<EmbedderLike> {
  const cached = embedderCache.get(kind);
  if (cached) return cached;

  await mkdir(FASTEMBED_CACHE_DIR, { recursive: true });
  process.env.FASTEMBED_CACHE_PATH ??= FASTEMBED_CACHE_DIR;
  process.env.FASTEMBED_CACHE_DIR ??= FASTEMBED_CACHE_DIR;

  if (kind === "minilm") {
    const e = new BundledEmbedder();
    embedderCache.set(kind, e);
    return e;
  }

  const fastembed = await import("fastembed");
  const { FlagEmbedding, EmbeddingModel } = fastembed as unknown as {
    FlagEmbedding: { init: (opts: unknown) => Promise<unknown> };
    EmbeddingModel: Record<string, string>;
  };
  const model = kind === "bge-small" ? EmbeddingModel.BGESmallENV15 : EmbeddingModel.BGEBaseENV15;
  await mkdir(join(FASTEMBED_CACHE_DIR, "BAAI"), { recursive: true });
  const instance = (await FlagEmbedding.init({
    model,
    cacheDir: FASTEMBED_CACHE_DIR,
  } as Record<string, unknown>)) as {
    embed: (texts: string[], batchSize?: number) => AsyncIterable<number[][]>;
  };

  const embedder: EmbedderLike = {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for await (const batch of instance.embed(texts, texts.length)) {
        for (const v of batch) out.push(new Float32Array(v));
      }
      return out;
    },
  };
  embedderCache.set(kind, embedder);
  return embedder;
}

async function evaluateCandidate(
  fixtures: EmbedRecipeFixtures,
  baselineWeakEntered: number,
  baselineEnteredGolden: Set<string>,
  key: CandidateKey,
): Promise<CandidateScore> {
  const cfg = CANDIDATES[key];
  const base: CandidateScore = {
    key: cfg.key,
    model: cfg.model,
    dim: cfg.dim,
    representation: cfg.representation,
    migrationNeeded: cfg.migrationNeeded,
    runnable: false,
    weakLift: null,
    regressionCount: null,
    weakEntered: null,
    baselineWeakEntered,
    baselineGoldenEntered: baselineEnteredGolden.size,
    goldenEntered: null,
  };

  try {
    return await withTimeout(
      (async () => {
        const corpus = uniqueRows(fixtures.corpusRows);
        const embedder = await getEmbedder(cfg.embedder);
        const memoryTexts = corpus.map((row) => representationText(cfg.representation, row));
        const memoryVecs = await embedder.embed(memoryTexts);
        const weakIds = new Set(fixtures.weakRows.map((r) => r.id));
        const goldenIds = new Set(fixtures.goldenRows.map((r) => r.id));
        const enteredWeak = new Set<string>();
        const enteredGolden = new Set<string>();

        for (const queryText of fixtures.queries) {
          const [qv] = await embedder.embed([queryText]);
          const ranked = corpus
            .map((row, idx) => ({ id: row.id, score: dot(qv!, memoryVecs[idx]!) }))
            .sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score))
            .slice(0, 20);
          for (const hit of ranked) {
            if (weakIds.has(hit.id)) enteredWeak.add(hit.id);
            if (goldenIds.has(hit.id)) enteredGolden.add(hit.id);
          }
        }

        let regressionCount = 0;
        for (const id of baselineEnteredGolden) {
          if (!enteredGolden.has(id)) regressionCount += 1;
        }

        return {
          ...base,
          runnable: true,
          weakLift: key === "minilm_body_only" ? 0 : enteredWeak.size - baselineWeakEntered,
          regressionCount,
          weakEntered: enteredWeak.size,
          baselineWeakEntered,
          baselineGoldenEntered: baselineEnteredGolden.size,
          goldenEntered: enteredGolden.size,
        };
      })(),
      Number(process.env.PENUMBRA_EMBED_RECIPE_TIMEOUT_MS ?? "180000"),
      `candidate ${key}`,
    );
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ...base, error };
  }
}

async function baselineEnteredSets(fixtures: EmbedRecipeFixtures): Promise<{
  golden: Set<string>;
}> {
  const cfg = CANDIDATES.minilm_body_only;
  const corpus = uniqueRows(fixtures.corpusRows);
  const embedder = await getEmbedder(cfg.embedder);
  const memoryVecs = await embedder.embed(corpus.map((row) => representationText(cfg.representation, row)));
  const goldenIds = new Set(fixtures.goldenRows.map((r) => r.id));
  const enteredGolden = new Set<string>();

  for (const queryText of fixtures.queries) {
    const [qv] = await embedder.embed([queryText]);
    const ranked = corpus
      .map((row, idx) => ({ id: row.id, score: dot(qv!, memoryVecs[idx]!) }))
      .sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score))
      .slice(0, 20);
    for (const hit of ranked) {
      if (goldenIds.has(hit.id)) enteredGolden.add(hit.id);
    }
  }

  return { golden: enteredGolden };
}

export async function loadFixtures(name = "synthetic.json"): Promise<EmbedRecipeFixtures> {
  if (name.endsWith(".json")) {
    const raw = await readFile(join(FIXTURE_DIR, name), "utf8");
    return JSON.parse(raw) as CombinedFixtureFile;
  }

  const [weakRaw, goldenRaw, corpusRaw, queriesRaw] = await Promise.all([
    readFile(join(FIXTURE_DIR, "weak-rows.json"), "utf8"),
    readFile(join(FIXTURE_DIR, "golden-rows.json"), "utf8"),
    readFile(join(FIXTURE_DIR, "corpus-rows.json"), "utf8"),
    readFile(join(FIXTURE_DIR, "queries.json"), "utf8"),
  ]);
  return {
    weakRows: JSON.parse(weakRaw) as EmbedRecipeRow[],
    goldenRows: JSON.parse(goldenRaw) as EmbedRecipeRow[],
    corpusRows: JSON.parse(corpusRaw) as EmbedRecipeRow[],
    queries: JSON.parse(queriesRaw) as string[],
  };
}

export async function loadDecision(): Promise<RecipeDecision> {
  const raw = await readFile(DECISION_PATH, "utf8");
  return JSON.parse(raw) as RecipeDecision;
}

export async function writeDecision(decision: RecipeDecision): Promise<void> {
  await mkdir(dirname(DECISION_PATH), { recursive: true });
  await Bun.write(DECISION_PATH, `${JSON.stringify(decision, null, 2)}\n`);
}

export async function evaluateCandidatesFromFixtures(
  fixtures: EmbedRecipeFixtures,
  candidateKeys?: CandidateKey[],
): Promise<CandidateScore[]> {
  const keys = candidateKeys ?? (Object.keys(CANDIDATES) as CandidateKey[]);
  const baseline = await baselineEnteredSets(fixtures);
  const baselineWeakEntered = 0;
  const out: CandidateScore[] = [];
  for (const key of keys) {
    out.push(await evaluateCandidate(fixtures, baselineWeakEntered, baseline.golden, key));
  }
  return out;
}
