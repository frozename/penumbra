import { assertGroupBy, groupKeyOf } from "./aggregate.js";
import { AssistanceSchema, type Episode } from "./manifest.js";

const ASSISTANCE_KINDS = AssistanceSchema.shape.kind.options;

type AssistanceKind = (typeof ASSISTANCE_KINDS)[number];

type OutcomeCounts = {
  model_failure: number;
  environment: number;
  baseline: number;
  resource: number;
  auth: number;
  blocked_correct: number;
  terminal_unverified: number;
  unknown: number;
};

type TerminalReport = { n_terminal: number; n_unknown: number };

type ArtifactReport = { produced: number; absent: number; rate: number };

type FinalCommitReport = {
  model: number;
  recovery: number;
  unknown: number;
  human_takeover: number;
  no_attempts: number;
};

type FinalCommitKind = keyof FinalCommitReport;

type AssistanceReport = Record<AssistanceKind, number> & { assisted_episodes: number };

type ContractFlagCount = { yes: number; no: number; unknown: number };

type ContractReport = {
  base_not_ancestor: ContractFlagCount;
  identity_mismatch: ContractFlagCount;
};

type DurationReport = {
  n: number;
  n_missing: number;
  sum: number;
  median: number | null;
};

type CostReport = {
  sum: number;
  n_missing: number;
  n_incomplete: number;
  complete: boolean;
};

type TimingsReport = {
  queue_ms: DurationReport;
  exec_ms: DurationReport;
  check_ms: DurationReport;
  e2e_ms: DurationReport;
};

type OperationalGroupReport = {
  key: string;
  n_episodes: number;
  n_attempts: number;
  outcomes: OutcomeCounts;
  terminal_completion: TerminalReport;
  artifact: ArtifactReport;
  final_commit: FinalCommitReport;
  assistance: AssistanceReport;
  contract: ContractReport;
  timings: TimingsReport;
  cost_usd: CostReport;
};

type CostAcc = { sum: number; nMissing: number; nIncomplete: number };

type GroupAcc = {
  key: string;
  nEpisodes: number;
  nAttempts: number;
  outcomes: OutcomeCounts;
  nTerminal: number;
  nUnknown: number;
  produced: number;
  finalCommit: FinalCommitReport;
  assistance: AssistanceReport;
  base: ContractFlagCount;
  identity: ContractFlagCount;
  cost: CostAcc;
};

const TIMING_KEYS = ["queue_ms", "exec_ms", "check_ms", "e2e_ms"] as const;

type TimingKey = (typeof TIMING_KEYS)[number];

function newOutcomes(): OutcomeCounts {
  return {
    model_failure: 0,
    environment: 0,
    baseline: 0,
    resource: 0,
    auth: 0,
    blocked_correct: 0,
    terminal_unverified: 0,
    unknown: 0,
  };
}

function newFinalCommit(): FinalCommitReport {
  return { model: 0, recovery: 0, unknown: 0, human_takeover: 0, no_attempts: 0 };
}

function newAssistance(): AssistanceReport {
  const kindCounts = {} as Record<AssistanceKind, number>;
  for (const kind of ASSISTANCE_KINDS) {
    kindCounts[kind] = 0;
  }
  return { ...kindCounts, assisted_episodes: 0 };
}

function newFlagCount(): ContractFlagCount {
  return { yes: 0, no: 0, unknown: 0 };
}

function newGroup(key: string): GroupAcc {
  return {
    key,
    nEpisodes: 0,
    nAttempts: 0,
    outcomes: newOutcomes(),
    nTerminal: 0,
    nUnknown: 0,
    produced: 0,
    finalCommit: newFinalCommit(),
    assistance: newAssistance(),
    base: newFlagCount(),
    identity: newFlagCount(),
    cost: { sum: 0, nMissing: 0, nIncomplete: 0 },
  };
}

function accumulateOutcome(outcomes: OutcomeCounts, ep: Episode): void {
  const outcome = ep.observed_outcome;
  switch (outcome.class) {
    case "model_failure":
      outcomes.model_failure += 1;
      return;
    case "environment_failure":
      outcomes[outcome.kind] += 1;
      return;
    case "blocked_correct":
      outcomes.blocked_correct += 1;
      return;
    case "terminal_unverified":
      outcomes.terminal_unverified += 1;
      return;
    case "unknown":
      outcomes.unknown += 1;
      return;
  }
}

function accumulateTerminal(acc: GroupAcc, ep: Episode): void {
  if (ep.observed_outcome.class === "unknown") {
    acc.nUnknown += 1;
    return;
  }
  acc.nTerminal += 1;
}

function finalCommitKind(ep: Episode): FinalCommitKind {
  const finalSha = ep.final_sha;
  const takenOver =
    finalSha !== null &&
    ep.assistance.some((entry) => entry.kind === "human_takeover" && entry.ref === finalSha);
  if (takenOver) {
    return "human_takeover";
  }
  const historyStatus = ep.attempt_history.status;
  if (historyStatus === "unavailable") {
    const count = ep.attempt_history.count;
    if (count === null || count > 0) {
      return "unknown";
    }
    return "no_attempts";
  }
  const last = ep.attempts[ep.attempts.length - 1];
  if (last === undefined) {
    return "no_attempts";
  }
  return last.commits.final_commit_attribution;
}

function accumulateAssistance(acc: AssistanceReport, ep: Episode): void {
  if (ep.assistance.length > 0) {
    acc.assisted_episodes += 1;
  }
  const kinds = new Set<AssistanceKind>();
  for (const entry of ep.assistance) {
    kinds.add(entry.kind);
  }
  for (const kind of kinds) {
    acc[kind] += 1;
  }
}

function accumulateFlag(count: ContractFlagCount, flag: boolean | null): void {
  if (flag === true) {
    count.yes += 1;
    return;
  }
  if (flag === false) {
    count.no += 1;
    return;
  }
  count.unknown += 1;
}

function accumulateContract(
  base: ContractFlagCount,
  identity: ContractFlagCount,
  ep: Episode,
): void {
  const historyStatus = ep.attempt_history.status;
  if (historyStatus === "partial" && ep.attempt_history.count !== null) {
    const pruned = ep.attempt_history.count - ep.attempts.length;
    for (let i = 0; i < pruned; i += 1) {
      accumulateFlag(base, null);
      accumulateFlag(identity, null);
    }
  } else if (historyStatus === "unavailable" && ep.attempt_history.count !== null) {
    const pruned = ep.attempt_history.count - ep.attempts.length;
    for (let i = 0; i < pruned; i += 1) {
      accumulateFlag(base, null);
      accumulateFlag(identity, null);
    }
  }
  for (const attempt of ep.attempts) {
    accumulateFlag(base, attempt.contract_flags.base_not_ancestor);
    accumulateFlag(identity, attempt.contract_flags.identity_mismatch);
  }
}

function accumulateCost(acc: CostAcc, ep: Episode): void {
  const usage = ep.lineage_usage;
  if (usage === null) {
    acc.nMissing += 1;
    return;
  }
  const costUsd = usage.cost_usd;
  if (costUsd === null) {
    acc.nMissing += 1;
    return;
  }
  acc.sum += costUsd;
  if (!usage.complete) {
    acc.nIncomplete += 1;
  }
}

function accumulateEpisode(acc: GroupAcc, ep: Episode): void {
  acc.nEpisodes += 1;
  const historyStatus = ep.attempt_history.status;
  if (historyStatus === "partial" && ep.attempt_history.count !== null) {
    acc.nAttempts += ep.attempt_history.count;
  } else if (historyStatus === "unavailable" && ep.attempt_history.count !== null) {
    acc.nAttempts += ep.attempt_history.count;
  } else {
    acc.nAttempts += ep.attempts.length;
  }
  accumulateOutcome(acc.outcomes, ep);
  accumulateTerminal(acc, ep);
  if (ep.final_sha !== null) {
    acc.produced += 1;
  }
  acc.finalCommit[finalCommitKind(ep)] += 1;
  accumulateAssistance(acc.assistance, ep);
  accumulateContract(acc.base, acc.identity, ep);
  accumulateCost(acc.cost, ep);
}

function episodeTimingValue(ep: Episode, key: TimingKey): number | null {
  const historyStatus = ep.attempt_history.status;
  if (historyStatus === "partial" || historyStatus === "unavailable") {
    return null;
  }
  if (ep.attempts.length === 0) {
    return null;
  }
  let sum = 0;
  for (const attempt of ep.attempts) {
    const value = attempt.timings[key];
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return sum;
}

function medianOf(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) {
    return null;
  }
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sorted[mid] ?? null;
  }
  const low = sorted[mid - 1] ?? 0;
  const high = sorted[mid] ?? 0;
  return (low + high) / 2;
}

function durationReport(episodes: readonly Episode[], key: TimingKey): DurationReport {
  const present: number[] = [];
  let missing = 0;
  let sum = 0;
  for (const ep of episodes) {
    const value = episodeTimingValue(ep, key);
    if (value === null) {
      missing += 1;
      continue;
    }
    present.push(value);
    sum += value;
  }
  present.sort((lhs, rhs) => lhs - rhs);
  return { n: present.length, n_missing: missing, sum, median: medianOf(present) };
}

function buildTimings(episodes: readonly Episode[]): TimingsReport {
  return {
    queue_ms: durationReport(episodes, "queue_ms"),
    exec_ms: durationReport(episodes, "exec_ms"),
    check_ms: durationReport(episodes, "check_ms"),
    e2e_ms: durationReport(episodes, "e2e_ms"),
  };
}

function buildGroup(acc: GroupAcc, episodes: readonly Episode[]): OperationalGroupReport {
  const nEpisodes = acc.nEpisodes;
  return {
    key: acc.key,
    n_episodes: nEpisodes,
    n_attempts: acc.nAttempts,
    outcomes: acc.outcomes,
    terminal_completion: {
      n_terminal: acc.nTerminal,
      n_unknown: acc.nUnknown,
    },
    artifact: {
      produced: acc.produced,
      absent: nEpisodes - acc.produced,
      rate: acc.produced / nEpisodes,
    },
    final_commit: acc.finalCommit,
    assistance: acc.assistance,
    contract: { base_not_ancestor: acc.base, identity_mismatch: acc.identity },
    timings: buildTimings(episodes),
    cost_usd: {
      sum: acc.cost.sum,
      n_missing: acc.cost.nMissing,
      n_incomplete: acc.cost.nIncomplete,
      complete: acc.cost.nMissing === 0 && acc.cost.nIncomplete === 0,
    },
  };
}

function summarizeGroup(key: string, episodes: readonly Episode[]): OperationalGroupReport {
  const acc = newGroup(key);
  for (const ep of episodes) {
    accumulateEpisode(acc, ep);
  }
  return buildGroup(acc, episodes);
}

function bucketFor(groups: Map<string, Episode[]>, key: string, ep: Episode): void {
  const bucket = groups.get(key);
  if (bucket === undefined) {
    groups.set(key, [ep]);
    return;
  }
  bucket.push(ep);
}

function summarizeOperational(
  episodes: readonly Episode[],
  opts: { groupBy: string },
): { groups: OperationalGroupReport[] } {
  const groupBy = assertGroupBy(opts.groupBy);
  const groups = new Map<string, Episode[]>();
  for (const ep of episodes) {
    bucketFor(groups, groupKeyOf(ep, groupBy), ep);
  }
  const sorted = [...groups.entries()].sort((lhs, rhs) => (lhs[0] < rhs[0] ? -1 : 1));
  return { groups: sorted.map(([key, bucket]) => summarizeGroup(key, bucket)) };
}

export { type CostReport, type DurationReport, type OperationalGroupReport, summarizeOperational };
