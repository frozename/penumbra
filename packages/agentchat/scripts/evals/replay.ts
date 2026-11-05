import type { HoldoutBundle, HoldoutLock } from "@penumbra/core/evals/fixture";

import { type Episode, EpisodeSchema } from "@penumbra/core/evals/manifest";

import type { CorpusFixture } from "./corpus.js";
import type { HoldoutStore } from "./grader/holdout-store.js";
import type { GraderScratch } from "./grader/scratch.js";

export interface ReplayOptions {
  scratch: Pick<GraderScratch, "buildBase" | "applyPatch">;
  store?: Pick<HoldoutStore, "readEntry" | "sessionId"> | undefined;
  lock?: HoldoutLock | undefined;
}

interface ResolvedBundle {
  bundle: HoldoutBundle;
  repoFiles: Record<string, string>;
}

interface ReplayVariant {
  key: string;
  patch: string;
}

async function resolveHoldoutBundle(
  entry: CorpusFixture,
  store: ReplayOptions["store"],
  lock: HoldoutLock | undefined,
): Promise<ResolvedBundle> {
  if (store === undefined) {
    throw new Error(`holdout store session required for ${entry.dir}`);
  }
  if (store.sessionId === null) {
    throw new Error(`holdout store session required for ${entry.dir}`);
  }
  const lockEntry = lock?.entries.find(
    (candidate) =>
      candidate.family_id === entry.fixture.family_id &&
      candidate.variant_id === entry.fixture.variant_id,
  );
  if (lockEntry === undefined) {
    throw new Error(`holdout store lock entry missing for ${entry.dir}`);
  }
  const bundle = await store.readEntry(lockEntry);
  return { bundle, repoFiles: bundle.repo_files };
}

async function resolveBundle(entry: CorpusFixture, opts: ReplayOptions): Promise<ResolvedBundle> {
  if (entry.bundle !== null) {
    return { bundle: entry.bundle, repoFiles: entry.repoFiles ?? entry.bundle.repo_files };
  }
  return await resolveHoldoutBundle(entry, opts.store, opts.lock);
}

function replayVariants(bundle: HoldoutBundle): ReplayVariant[] {
  const badVariants = bundle.patches.bad.map((patch, index): ReplayVariant => {
    return { key: `bad-${String(index)}`, patch };
  });
  return [{ key: "good", patch: bundle.patches.good }, ...badVariants];
}

function unknownIdentityField(): {
  value: null;
  provenance: "unknown";
  missing_reason: string;
} {
  return { value: null, provenance: "unknown", missing_reason: "fixture_replay" };
}

function replayEpisode(entry: CorpusFixture, base: string, sha: string, key: string): Episode {
  const familyId = entry.fixture.family_id;
  const variantId = entry.fixture.variant_id;
  return EpisodeSchema.parse({
    schema_version: 1,
    episode_id: `replay:${familyId}:${variantId}:${key}`,
    family_id: familyId,
    fixture_ref: { family_id: familyId, variant_id: variantId },
    split: entry.fixture.split,
    design: "controlled",
    failure_type: entry.fixture.failure_type,
    task_digest: entry.fixture.task_digest,
    task_refs: { issues: [], bundle_ids: [] },
    repo: { base_sha: base, dependency_lock_sha256: null },
    recipe_id: null,
    model_identity: {
      requested: unknownIdentityField(),
      effective: unknownIdentityField(),
      quant: unknownIdentityField(),
      engine: unknownIdentityField(),
      adapter: unknownIdentityField(),
      config_sha256: null,
      artifact_identity: null,
    },
    harness_build: { sha: null, missing_reason: "fixture_replay" },
    environment: { worktree_kind: null, os: null, bun_version: null },
    lineage: { root_handoff_id: null, handoff_ids: [], shape: "fixture" },
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "fixture_replay",
    },
    attempts: [
      {
        n: 1,
        handoff_id: `replay:${variantId}:${key}`,
        dispatch_attempt: null,
        head_sha: sha,
        commits: {
          final_commit_attribution: "unknown",
          attribution_basis: "none",
          autocommit_flag: null,
        },
        contract_flags: {
          scope: "attempt",
          source: "none",
          base_not_ancestor: null,
          identity_mismatch: null,
        },
        timings: { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: null },
        usage: { tokens: null, cost_usd: null, scope: "unknown", missing_reason: "fixture_replay" },
      },
    ],
    assistance: [],
    final_sha: sha,
    receipts: [],
    observed_outcome: { class: "terminal_unverified" },
    handoff_reliability: null,
    lineage_usage: null,
    labels: { replay_patch: key },
  });
}

export async function buildReplayEpisodes(
  fixtures: readonly CorpusFixture[],
  opts: ReplayOptions,
): Promise<Episode[]> {
  const episodes: Episode[] = [];
  for (const entry of fixtures) {
    const { bundle, repoFiles } = await resolveBundle(entry, opts);
    const base = await opts.scratch.buildBase(repoFiles);
    if (base !== entry.fixture.base_sha) {
      throw new Error(`base_sha mismatch ${entry.dir}`);
    }
    for (const variant of replayVariants(bundle)) {
      const sha = await opts.scratch.applyPatch(base, variant.patch);
      episodes.push(replayEpisode(entry, base, sha, variant.key));
    }
  }
  return episodes;
}
