import type { GroupReport } from "@penumbra/core/evals/aggregate";
import type { HoldoutLock } from "@penumbra/core/evals/fixture";
import type { Episode } from "@penumbra/core/evals/manifest";

import { canonicalJson } from "@penumbra/core/evals/canonical";
import {
  applyHoldoutGate,
  holdoutGate,
  type HoldoutStatus,
  type UnsealToken,
} from "@penumbra/core/evals/compare";

export interface ReportVerify {
  status: string;
  verdict?: "pass" | "fail";
  fail_reason?: string | null;
  reason?: string;
  detail?: string;
}

export interface ReportEpisode {
  episode_id: string;
  family_id: string;
  replay_patch: string | null;
  final_sha: string | null;
  grade: string | null;
  verify: ReportVerify;
}

export interface ReportUsageEntry {
  root_handoff_id: string;
  lineage_usage: unknown;
  usage_missing_reason: string | null;
}

export interface ReportIngest {
  lineages: number;
  excluded: { helper_check_verifier: number; helper_rubric_grader: number };
  orphan_events_dropped: number;
  usage: ReportUsageEntry[];
}

export interface ReportInput {
  seed: number;
  stages: readonly string[];
  episodes: readonly Episode[];
  episodeReports: readonly ReportEpisode[];
  ingest: ReportIngest | null;
  groups: readonly GroupReport[];
  lock: HoldoutLock | null;
  unseal: UnsealToken | null;
}

function runLine(input: ReportInput): Record<string, unknown> {
  const gate = holdoutGate(input.lock, input.unseal);
  const { status }: { status: HoldoutStatus } = applyHoldoutGate(input.episodes, gate);
  return {
    type: "run",
    seed: input.seed,
    stages: [...input.stages],
    holdout: status,
    underpowered: input.groups.some((group) => group.underpowered),
    n_episodes: input.episodes.length,
  };
}

function ingestLine(ingest: ReportIngest): Record<string, unknown> {
  return {
    type: "ingest",
    lineages: ingest.lineages,
    excluded: ingest.excluded,
    orphan_events_dropped: ingest.orphan_events_dropped,
    usage: ingest.usage,
  };
}

function episodeLine(episode: ReportEpisode): Record<string, unknown> {
  const verify: Record<string, unknown> = { status: episode.verify.status };
  if (episode.verify.verdict !== undefined) {
    verify["verdict"] = episode.verify.verdict;
  }
  if (episode.verify.fail_reason !== undefined) {
    verify["fail_reason"] = episode.verify.fail_reason;
  }
  if (episode.verify.reason !== undefined) {
    verify["reason"] = episode.verify.reason;
  }
  if (episode.verify.detail !== undefined) {
    verify["detail"] = episode.verify.detail;
  }
  return {
    type: "episode",
    episode_id: episode.episode_id,
    family_id: episode.family_id,
    replay_patch: episode.replay_patch,
    final_sha: episode.final_sha,
    grade: episode.grade,
    verify,
  };
}

function aggregateLine(group: GroupReport): Record<string, unknown> {
  return { type: "aggregate", ...group };
}

export function renderReport(input: ReportInput): string {
  const lines: Record<string, unknown>[] = [runLine(input)];
  if (input.ingest !== null) {
    lines.push(ingestLine(input.ingest));
  }
  for (const episode of input.episodeReports) {
    lines.push(episodeLine(episode));
  }
  for (const group of input.groups) {
    lines.push(aggregateLine(group));
  }
  return `${lines.map((line) => canonicalJson(line)).join("\n")}\n`;
}
