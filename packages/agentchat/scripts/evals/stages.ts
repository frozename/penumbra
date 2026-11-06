import type { HoldoutBundle } from "@penumbra/core/evals/fixture";
import type { Episode, ReceiptClaimBody } from "@penumbra/core/evals/manifest";

import { aggregateEpisodes } from "@penumbra/core/evals/aggregate";
import { canonicalJson } from "@penumbra/core/evals/canonical";
import { comparePaired, ObservationalComparisonError } from "@penumbra/core/evals/compare";
import { EpisodeSchema, RecipeArmSchema } from "@penumbra/core/evals/manifest";
import { planPairedRun } from "@penumbra/core/evals/plan";

import { CorpusLintError } from "./corpus.js";
import { seededShuffle } from "./grader/evaluate.js";
import { grade } from "./grader/grade.js";
import { HoldoutStoreError } from "./grader/holdout-store.js";
import { verifyReceipt, type VerifyResult } from "./grader/verify.js";
import { ingestDb } from "./ingest-db.js";
import { loadRecipes } from "./recipes.js";
import { buildReplayEpisodes } from "./replay.js";
import {
  renderReport,
  type ReportEpisode,
  type ReportIngest,
  type ReportVerify,
} from "./report.js";
import {
  buildVerifyContext,
  ensureCorpus,
  ensureEpisodes,
  ensureGrading,
  failOutcome,
  type GradingEnv,
  intFlag,
  okOutcome,
  resolveFixtureFor,
  type SessionState,
  sessionVerifier,
  STAGE_NAMES,
  StageError,
  stageFlag,
  type StageInvocation,
  type StageName,
  type StageOutcome,
  verifyKey,
} from "./session.js";

const flagSet = (...names: string[]): ReadonlySet<string> => new Set(names);

const STAGE_FLAGS: Record<StageName, ReadonlySet<string>> = {
  validate: flagSet("--corpus", "--out"),
  ingest: flagSet("--db", "--retention-days", "--t0-retention-days", "--out"),
  replay: flagSet("--corpus", "--only", "--holdout-store", "--lock", "--unseal", "--out"),
  grade: flagSet(
    "--episodes",
    "--corpus",
    "--holdout-store",
    "--lock",
    "--unseal",
    "--seed",
    "--out",
  ),
  verify: flagSet(
    "--episodes",
    "--corpus",
    "--holdout-store",
    "--lock",
    "--unseal",
    "--seed",
    "--out",
  ),
  aggregate: flagSet(
    "--episodes",
    "--corpus",
    "--seed",
    "--group-by",
    "--min-families",
    "--bootstrap",
    "--out",
  ),
  compare: flagSet(
    "--episodes",
    "--corpus",
    "--baseline",
    "--treatment",
    "--seed",
    "--min-families",
    "--out",
  ),
  plan: flagSet("--corpus", "--seed", "--repeats", "--out"),
  report: flagSet("--episodes", "--corpus", "--out"),
};

export type ParseResult =
  | { ok: true; stages: StageInvocation[] }
  | { ok: false; blocked: boolean; message: string };

function parseStageFlags(
  argv: readonly string[],
  start: number,
  name: StageName,
): { ok: true; flags: [string, string][]; next: number } | { ok: false; message: string } {
  const flags: [string, string][] = [];
  let i = start;
  while (i < argv.length) {
    const flag = argv[i];
    if (!flag?.startsWith("-")) {
      break;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return { ok: false, message: `missing value for ${flag}` };
    }
    if (!STAGE_FLAGS[name].has(flag)) {
      return { ok: false, message: `unknown flag ${flag} for ${name}` };
    }
    flags.push([flag, value]);
    i += 2;
  }
  return { ok: true, flags, next: i };
}

export function parseStages(argv: readonly string[]): ParseResult {
  const stages: StageInvocation[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined || !(STAGE_NAMES as readonly string[]).includes(token)) {
      return { ok: false, blocked: true, message: "" };
    }
    const name = token as StageName;
    const parsed = parseStageFlags(argv, i + 1, name);
    if (!parsed.ok) {
      return { ok: false, blocked: false, message: parsed.message };
    }
    stages.push({ name, flags: parsed.flags });
    i = parsed.next;
  }
  return { ok: true, stages };
}

// --- stage handlers ------------------------------------------------------------

async function stageValidate(session: SessionState): Promise<StageOutcome> {
  const fixtures = await ensureCorpus(session);
  return okOutcome(canonicalJson({ status: "ok", fixtures: fixtures.length }));
}

function parseIngestReport(text: string): ReportIngest | null {
  let summary: ReportIngest | null = null;
  const usage: ReportIngest["usage"] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw["type"] === "ingest_summary") {
      summary = {
        lineages: raw["lineages"] as number,
        excluded: raw["excluded"] as ReportIngest["excluded"],
        orphan_events_dropped: raw["orphan_events_dropped"] as number,
        usage: [],
      };
    } else if (raw["type"] === "lineage") {
      usage.push({
        root_handoff_id: raw["root_handoff_id"] as string,
        lineage_usage: raw["lineage_usage"],
        usage_missing_reason: (raw["usage_missing_reason"] as string | null) ?? null,
      });
    }
  }
  if (summary === null) {
    return null;
  }
  return { ...summary, usage };
}

function stageIngest(session: SessionState, stage: StageInvocation): StageOutcome {
  const result = ingestDb({
    dbPath: stageFlag(stage, "--db"),
    storageRoot: session.deps.storageRoot,
    retentionDays: intFlag(stage, "--retention-days"),
    t0RetentionDays: intFlag(stage, "--t0-retention-days"),
    now: session.deps.now(),
  });
  if (result.code !== 0) {
    return failOutcome(result.code, result.stderr);
  }
  session.ingest = parseIngestReport(result.stdout);
  return okOutcome(result.stdout);
}

async function stageReplay(session: SessionState, stage: StageInvocation): Promise<StageOutcome> {
  const fixtures = await ensureCorpus(session);
  const onlyRaw = stageFlag(stage, "--only");
  let selected = fixtures;
  if (onlyRaw !== undefined) {
    const wanted = new Set(
      onlyRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    );
    const known = new Set(fixtures.map((entry) => entry.dir));
    for (const dir of wanted) {
      if (!known.has(dir)) {
        throw new StageError(2, `fixture_unknown ${dir}\n`);
      }
    }
    selected = fixtures.filter((entry) => wanted.has(entry.dir));
  }
  const episodes = await buildReplayEpisodes(selected, {
    scratch: session.scratch,
    store: session.store ?? undefined,
    lock: session.lock ?? undefined,
  });
  session.episodes = episodes;
  return okOutcome(
    canonicalJson({ type: "replay", episodes: episodes.length, fixtures: selected.length }),
  );
}

type GradeOutcome =
  | { kind: "claim"; claim: ReceiptClaimBody }
  | { kind: "ungradeable"; reason: string };

async function resolveGradeBundle(
  session: SessionState,
  ref: { family_id: string; variant_id: string },
): Promise<HoldoutBundle | null> {
  const corpus = session.corpusFixtures?.find(
    (entry) =>
      entry.fixture.family_id === ref.family_id && entry.fixture.variant_id === ref.variant_id,
  );
  if (corpus !== undefined && corpus.bundle !== null) {
    return corpus.bundle;
  }
  const lockEntry = session.lock?.entries.find(
    (entry) => entry.family_id === ref.family_id && entry.variant_id === ref.variant_id,
  );
  if (lockEntry !== undefined && session.store !== null) {
    return await session.store.readEntry(lockEntry);
  }
  return null;
}

async function gradeEpisode(
  session: SessionState,
  env: GradingEnv,
  episode: Episode,
): Promise<GradeOutcome> {
  const ref = episode.fixture_ref;
  if (ref === null) {
    return { kind: "ungradeable", reason: "fixture_unknown" };
  }
  if (episode.repo.base_sha === null) {
    return { kind: "ungradeable", reason: "base_missing" };
  }
  if (episode.final_sha === null) {
    return { kind: "ungradeable", reason: "final_missing" };
  }
  const bundle = await resolveGradeBundle(session, ref);
  if (bundle === null) {
    return { kind: "ungradeable", reason: "fixture_unknown" };
  }
  const result = await grade(
    { fixture_ref: ref, base_sha: episode.repo.base_sha, final_sha: episode.final_sha },
    {
      bundle,
      scratch: session.scratch,
      controls: env.controls,
      deps: env.depProvider,
      sandbox: env.sandboxKind,
      timeoutMs: session.deps.timeoutMs,
    },
  );
  if ("ungradeable" in result) {
    return { kind: "ungradeable", reason: result.ungradeable };
  }
  return { kind: "claim", claim: result };
}

async function stageGrade(session: SessionState, stage: StageInvocation): Promise<StageOutcome> {
  const episodes = ensureEpisodes(session, stage);
  await ensureCorpus(session);
  const env = await ensureGrading(session);
  const ordered = seededShuffle(episodes, session.seed);
  session.episodes = ordered;
  for (const [index, episode] of ordered.entries()) {
    const outcome = await gradeEpisode(session, env, episode);
    if (outcome.kind === "claim") {
      ordered[index] = EpisodeSchema.parse({
        ...episode,
        receipts: [...episode.receipts, outcome.claim],
      });
      session.gradeOutcomes.set(episode.episode_id, outcome.claim.claimed_verdict);
    } else {
      session.gradeOutcomes.set(episode.episode_id, `ungradeable:${outcome.reason}`);
    }
  }
  return okOutcome(canonicalJson({ type: "grade", episodes: ordered.length }));
}

async function stageVerify(session: SessionState, stage: StageInvocation): Promise<StageOutcome> {
  const episodes = ensureEpisodes(session, stage);
  await ensureCorpus(session);
  session.verifyCtx ??= buildVerifyContext(session);
  const ctx = await session.verifyCtx;
  for (const episode of episodes) {
    for (const claim of episode.receipts) {
      if (claim.kind !== "hidden_assertion") {
        continue;
      }
      const key = verifyKey(episode.episode_id, claim.receipt_digest);
      if (session.verifyCache.has(key)) {
        continue;
      }
      const result = await verifyReceipt(claim, episode, ctx);
      session.verifyCache.set(key, result);
    }
  }
  return okOutcome(canonicalJson({ type: "verify", episodes: episodes.length }));
}

async function stageAggregate(
  session: SessionState,
  stage: StageInvocation,
): Promise<StageOutcome> {
  const episodes = ensureEpisodes(session, stage);
  await ensureCorpus(session);
  const result = await aggregateEpisodes(episodes, {
    verifier: sessionVerifier(session),
    resolveFixture: (ref) => resolveFixtureFor(session, ref),
    groupBy: stageFlag(stage, "--group-by") ?? "split",
    minFamilies: intFlag(stage, "--min-families") ?? 10,
    seed: intFlag(stage, "--seed") ?? session.seed,
    B: intFlag(stage, "--bootstrap") ?? 2000,
  });
  session.groups = result.groups;
  return okOutcome(canonicalJson({ type: "aggregate", groups: result.groups }));
}

async function stageCompare(session: SessionState, stage: StageInvocation): Promise<StageOutcome> {
  const episodes = ensureEpisodes(session, stage);
  const baselineRaw = stageFlag(stage, "--baseline");
  const treatmentRaw = stageFlag(stage, "--treatment");
  if (baselineRaw === undefined || treatmentRaw === undefined) {
    throw new StageError(2, "usage: compare requires --baseline and --treatment\n");
  }
  const baseline = RecipeArmSchema.safeParse(baselineRaw);
  const treatment = RecipeArmSchema.safeParse(treatmentRaw);
  if (!baseline.success || !treatment.success) {
    throw new StageError(2, "usage: unknown recipe arm\n");
  }
  if (baselineRaw === treatmentRaw) {
    throw new StageError(2, "usage: baseline and treatment must differ\n");
  }
  if (!episodes.some((episode) => episode.design === "observational")) {
    await ensureCorpus(session);
  }
  try {
    const report = await comparePaired(episodes, {
      baseline: baseline.data,
      treatment: treatment.data,
      recipes: loadRecipes(),
      verifier: sessionVerifier(session),
      resolveFixture: (ref) => resolveFixtureFor(session, ref),
      lock: session.lock,
      unseal: session.grant,
      minFamilies: intFlag(stage, "--min-families") ?? 10,
      seed: intFlag(stage, "--seed") ?? session.seed,
    });
    return okOutcome(canonicalJson(report));
  } catch (err) {
    if (err instanceof ObservationalComparisonError) {
      return {
        code: 2,
        output: `${canonicalJson({ status: "refused", reason: "observational_comparison" })}\n`,
        stderr: "",
      };
    }
    throw err;
  }
}

async function stagePlan(session: SessionState, stage: StageInvocation): Promise<StageOutcome> {
  const fixtures = await ensureCorpus(session);
  const plan = planPairedRun({
    fixtures: fixtures.map((entry) => ({
      family_id: entry.fixture.family_id,
      variant_id: entry.fixture.variant_id,
      split: entry.fixture.split,
    })),
    recipes: loadRecipes(),
    lock: session.lock,
    unseal: session.grant,
    seed: intFlag(stage, "--seed") ?? session.seed,
    repeats: intFlag(stage, "--repeats") ?? 1,
  });
  return okOutcome(canonicalJson(plan));
}

function mapVerifyResult(result: VerifyResult): ReportVerify {
  if (result.status === "verified") {
    return { status: "verified", verdict: result.verdict, fail_reason: result.fail_reason };
  }
  return result.detail === undefined
    ? { status: "rejected", reason: result.reason }
    : { status: "rejected", reason: result.reason, detail: result.detail };
}

function reportVerify(session: SessionState, episode: Episode): ReportVerify {
  const hidden = episode.receipts.filter((claim) => claim.kind === "hidden_assertion");
  if (hidden.length === 0) {
    return { status: "none" };
  }
  let fallback: ReportVerify | undefined;
  for (const claim of hidden) {
    const result = session.verifyCache.get(verifyKey(episode.episode_id, claim.receipt_digest));
    if (result === undefined) {
      continue;
    }
    const mapped = mapVerifyResult(result);
    if (mapped.status === "verified") {
      return mapped;
    }
    fallback ??= mapped;
  }
  return fallback ?? { status: "pending" };
}

function reportEpisode(session: SessionState, episode: Episode): ReportEpisode {
  return {
    episode_id: episode.episode_id,
    family_id: episode.family_id,
    replay_patch: episode.labels["replay_patch"] ?? null,
    final_sha: episode.final_sha,
    grade: session.gradeOutcomes.get(episode.episode_id) ?? null,
    verify: reportVerify(session, episode),
  };
}

function stageReport(
  session: SessionState,
  stage: StageInvocation,
  stageNames: readonly string[],
): Promise<StageOutcome> {
  const episodes = ensureEpisodes(session, stage);
  const episodeReports = episodes.map((episode) => reportEpisode(session, episode));
  return Promise.resolve(
    okOutcome(
      renderReport({
        seed: session.seed,
        stages: stageNames,
        episodes,
        episodeReports,
        ingest: session.ingest,
        groups: session.groups,
        lock: session.lock,
        unseal: session.grant,
      }),
    ),
  );
}

function stageErrorOutcome(err: unknown): StageOutcome {
  if (err instanceof StageError) {
    const message = err.message.endsWith("\n") ? err.message : `${err.message}\n`;
    return failOutcome(err.code, message);
  }
  if (err instanceof CorpusLintError) {
    return failOutcome(1, `corpus_lint_failed ${err.message}\n`);
  }
  if (err instanceof HoldoutStoreError) {
    return failOutcome(2, `${err.code} ${err.message}\n`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return failOutcome(1, `${message}\n`);
}

export async function runStage(
  session: SessionState,
  stage: StageInvocation,
  stageNames: readonly string[],
): Promise<StageOutcome> {
  try {
    switch (stage.name) {
      case "validate":
        return await stageValidate(session);
      case "ingest":
        return stageIngest(session, stage);
      case "replay":
        return await stageReplay(session, stage);
      case "grade":
        return await stageGrade(session, stage);
      case "verify":
        return await stageVerify(session, stage);
      case "aggregate":
        return await stageAggregate(session, stage);
      case "compare":
        return await stageCompare(session, stage);
      case "plan":
        return await stagePlan(session, stage);
      case "report":
        return await stageReport(session, stage, stageNames);
    }
  } catch (err) {
    return stageErrorOutcome(err);
  }
}
