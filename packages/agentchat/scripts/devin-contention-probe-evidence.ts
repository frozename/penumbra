export type FailureClassification =
  | "boot_timeout"
  | "database_locked"
  | "duplicate_session_id"
  | "lock_window_unverified"
  | "missing_session_id"
  | "missing_session_rows"
  | "nonzero_exit"
  | "serialized_dispatch"
  | "sqlite_busy"
  | "target_instrumentation_absent"
  | "transport_close"
  | "zero_sessions_created";

export interface DbSnapshot {
  integrityCheck: string;
  journalMode: string;
  sessionsRowCount: number;
  walBytes: number;
}

export interface ProbeFixtureEvent {
  atMs: number;
  kind: string;
  pid: number;
  round: number;
  sessionId: string | null;
}

export interface LockControlEvidence {
  lockAcquiredAt: number;
  lockAcquiredWallMs: number;
  lockReleasedAt: number;
  lockReleasedWallMs: number;
}

export interface RuntimeStamp {
  bunVersion: string;
  platform: string;
  sqliteSetlkTimeout: boolean;
  sqliteVersion: string;
}

export interface LockWindowEvidence {
  baselineExceededHold: boolean;
  overlapCount: number;
  pairsEvaluated: number;
  satisfied: boolean;
}

export interface ProbePredicateResult {
  fired: boolean;
  measurement: number | null;
  threshold: number;
}

export interface SerializedDispatchEvidence {
  intervalOverlap: ProbePredicateResult;
  receivedSkew: ProbePredicateResult;
  respondingSkew: ProbePredicateResult;
  sendSkew: ProbePredicateResult;
}

export interface LockFreeControlEvidence {
  classifications: FailureClassification[];
  fixtureEvents: ProbeFixtureEvent[];
  maxSendSkewMs: number;
  processes: ProbeProcessResult[];
  round: number;
}

export interface ProbeProcessResult {
  endAt: number | null;
  error: string | null;
  exitCode: number | null;
  index: number;
  pid: number;
  sessionId: string | null;
  sessionNewResponseAt: number;
  sessionNewSendAt: number;
  startAt: number;
  stderrTail: string;
}

export interface ProbeRoundResult {
  classifications: FailureClassification[];
  fixtureEvents: ProbeFixtureEvent[];
  lockFreeControl: LockFreeControlEvidence | null;
  lockControl: LockControlEvidence | null;
  lockWindow: LockWindowEvidence;
  maxSendSkewMs: number;
  postDb: DbSnapshot;
  preDb: DbSnapshot;
  processes: ProbeProcessResult[];
  round: number;
  runtime: RuntimeStamp;
  serializedDispatch: SerializedDispatchEvidence;
}

export interface ProbeResult {
  ok: boolean;
  rounds: ProbeRoundResult[];
  summary: {
    classifications: FailureClassification[];
    concurrency: number;
    rounds: number;
  };
}

export interface ProbeRunOptions {
  allowRealStore?: boolean;
  args: string[];
  binary: string;
  concurrency: number;
  dbPath: string;
  minOverlap: number;
  outPath?: string;
  requireOverlap: boolean;
  rounds: number;
  sqliteLockControlMs: number;
  spawnStaggerMs?: number;
  summarize?: boolean;
}

export type PendingRoundResult = Omit<
  ProbeRoundResult,
  "classifications" | "lockWindow" | "serializedDispatch"
>;

const MAX_SEND_SKEW_MS = 25;
// Receive spread is measured across processes on a shared wall clock, so it
// includes OS pipe/scheduler jitter; keep it tolerant of jitter yet far below
// the skew a genuinely serialized target produces (hundreds of ms and up).
const MAX_RECEIVE_SKEW_MS = 100;

export function maxSendSkew(results: ProbeProcessResult[]): number {
  const sendTimes = results.map((result) => result.sessionNewSendAt).filter((sendAt) => sendAt > 0);
  const min = Math.min(...sendTimes);
  const max = Math.max(...sendTimes);
  return sendTimes.length === 0 ? 0 : max - min;
}

function maxIntervalOverlap(results: ProbeProcessResult[]): number {
  let max = 0;
  const attempted = results.filter((result) => result.sessionNewSendAt > 0);
  for (const probe of attempted) {
    const at = probe.sessionNewSendAt;
    const overlap = attempted.filter(
      (candidate) => candidate.sessionNewSendAt <= at && candidate.sessionNewResponseAt >= at,
    ).length;
    max = Math.max(max, overlap);
  }
  return max;
}

function classificationsForProcess(result: ProbeProcessResult): FailureClassification[] {
  const evidence = `${result.error ?? ""}\n${result.stderrTail}`;
  const classes: FailureClassification[] = [];
  if (/SQLITE_BUSY/i.test(evidence)) {
    classes.push("sqlite_busy");
  }
  if (/boot_timeout|initialize timed out/i.test(evidence)) {
    classes.push("boot_timeout");
  }
  if (/database is locked/i.test(evidence)) {
    classes.push("database_locked");
  }
  if (/transport closed/i.test(evidence)) {
    classes.push("transport_close");
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    classes.push("nonzero_exit");
  }
  if (result.error === null && result.sessionId === null) {
    classes.push("missing_session_id");
  }
  return classes;
}

function classifyErrors(results: ProbeProcessResult[]): Set<FailureClassification> {
  const classes = new Set<FailureClassification>();
  for (const result of results) {
    for (const classification of classificationsForProcess(result)) {
      classes.add(classification);
    }
  }
  return classes;
}

function sessionNewLatency(result: ProbeProcessResult): number | null {
  if (result.sessionNewSendAt <= 0 || result.sessionNewResponseAt <= 0) {
    return null;
  }
  return result.sessionNewResponseAt - result.sessionNewSendAt;
}

interface LockWindowPair {
  baselineLatency: number;
  lockedLatency: number;
}

function lockWindowPairs(round: PendingRoundResult): LockWindowPair[] {
  if (round.lockControl === null || round.lockFreeControl === null) {
    return [];
  }
  const controlByIndex = new Map(
    round.lockFreeControl.processes.map((result) => [result.index, result]),
  );
  const pairs: LockWindowPair[] = [];
  for (const locked of round.processes) {
    if (locked.sessionId === null || locked.error !== null) {
      continue;
    }
    const control = controlByIndex.get(locked.index);
    if (control === undefined) {
      continue;
    }
    if (control.sessionId === null || control.error !== null) {
      continue;
    }
    const baselineLatency = sessionNewLatency(control);
    const lockedLatency = sessionNewLatency(locked);
    if (baselineLatency === null || lockedLatency === null) {
      continue;
    }
    pairs.push({ baselineLatency, lockedLatency });
  }
  return pairs;
}

function buildLockWindowEvidence(
  round: PendingRoundResult,
  options: ProbeRunOptions,
): LockWindowEvidence {
  if (options.sqliteLockControlMs <= 0) {
    return { baselineExceededHold: false, overlapCount: 0, pairsEvaluated: 0, satisfied: true };
  }
  let baselineExceededHold = false;
  let overlapCount = 0;
  const pairs = lockWindowPairs(round);
  for (const { baselineLatency, lockedLatency } of pairs) {
    if (baselineLatency >= options.sqliteLockControlMs) {
      baselineExceededHold = true;
      continue;
    }
    if (lockedLatency - baselineLatency >= options.sqliteLockControlMs - MAX_SEND_SKEW_MS) {
      overlapCount++;
    }
  }
  return {
    baselineExceededHold,
    overlapCount,
    pairsEvaluated: pairs.length,
    satisfied: !baselineExceededHold && overlapCount >= options.minOverlap,
  };
}

function hasTargetInstrumentation(
  round: PendingRoundResult,
  control: LockFreeControlEvidence | null,
): boolean {
  if (round.fixtureEvents.length > 0) {
    return true;
  }
  return control !== null && control.fixtureEvents.length > 0;
}

function fixtureEventSkew(events: ProbeFixtureEvent[], kind: string): number | null {
  const eventTimes = events.filter((event) => event.kind === kind).map((event) => event.atMs);
  if (eventTimes.length < 2) {
    return null;
  }
  return Math.max(...eventTimes) - Math.min(...eventTimes);
}

function skewPredicateResult(
  events: ProbeFixtureEvent[],
  kind: string,
  requireOverlap: boolean,
): ProbePredicateResult {
  const measurement = fixtureEventSkew(events, kind);
  return {
    fired: requireOverlap && measurement !== null && measurement > MAX_RECEIVE_SKEW_MS,
    measurement,
    threshold: MAX_RECEIVE_SKEW_MS,
  };
}

function buildSerializedDispatchEvidence(
  round: PendingRoundResult,
  options: ProbeRunOptions,
  control: LockFreeControlEvidence | null,
): SerializedDispatchEvidence {
  const intervalOverlapCount = maxIntervalOverlap(round.processes);
  return {
    intervalOverlap: {
      fired: options.requireOverlap && intervalOverlapCount < options.minOverlap,
      measurement: intervalOverlapCount,
      threshold: options.minOverlap,
    },
    receivedSkew: skewPredicateResult(
      round.fixtureEvents,
      "session_new_received",
      options.requireOverlap,
    ),
    respondingSkew: skewPredicateResult(
      control?.fixtureEvents ?? round.fixtureEvents,
      "session_new_responding",
      options.requireOverlap,
    ),
    sendSkew: {
      fired: options.requireOverlap && round.maxSendSkewMs > MAX_SEND_SKEW_MS,
      measurement: round.maxSendSkewMs,
      threshold: MAX_SEND_SKEW_MS,
    },
  };
}

export function controlEvidenceFor(round: ProbeRoundResult): LockFreeControlEvidence {
  return {
    classifications: round.classifications,
    fixtureEvents: round.fixtureEvents,
    maxSendSkewMs: round.maxSendSkewMs,
    processes: round.processes,
    round: round.round,
  };
}

function classifyRound(
  round: PendingRoundResult,
  options: ProbeRunOptions,
  control: LockFreeControlEvidence | null,
  serializedDispatch: SerializedDispatchEvidence,
  lockWindow: LockWindowEvidence,
): FailureClassification[] {
  const classes = classifyErrors(round.processes);
  if (control !== null) {
    for (const classification of control.classifications) {
      classes.add(classification);
    }
  }
  const sessionIds = round.processes.flatMap((result) =>
    result.sessionId === null ? [] : [result.sessionId],
  );
  const uniqueSessionIds = new Set(sessionIds);

  if (uniqueSessionIds.size === 0) {
    classes.add("zero_sessions_created");
  }
  if (options.requireOverlap && !hasTargetInstrumentation(round, control)) {
    classes.add("target_instrumentation_absent");
  }
  if (sessionIds.length !== uniqueSessionIds.size) {
    classes.add("duplicate_session_id");
  }
  if (round.postDb.sessionsRowCount < round.preDb.sessionsRowCount + uniqueSessionIds.size) {
    classes.add("missing_session_rows");
  }
  if (
    serializedDispatch.sendSkew.fired ||
    serializedDispatch.intervalOverlap.fired ||
    serializedDispatch.receivedSkew.fired ||
    serializedDispatch.respondingSkew.fired
  ) {
    classes.add("serialized_dispatch");
  }
  if (!lockWindow.satisfied) {
    classes.add("lock_window_unverified");
  }
  return [...classes].sort();
}

export function evaluateRound(
  partial: PendingRoundResult,
  options: ProbeRunOptions,
  control: LockFreeControlEvidence | null,
): ProbeRoundResult {
  const serializedDispatch = buildSerializedDispatchEvidence(partial, options, control);
  const lockWindow = buildLockWindowEvidence(partial, options);
  const classifications = classifyRound(partial, options, control, serializedDispatch, lockWindow);
  return { ...partial, classifications, lockWindow, serializedDispatch };
}
