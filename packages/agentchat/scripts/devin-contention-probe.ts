import { Database } from "bun:sqlite";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";

type FailureClassification =
  | "boot_timeout"
  | "database_locked"
  | "duplicate_session_id"
  | "missing_session_id"
  | "missing_session_rows"
  | "nonzero_exit"
  | "serialized_dispatch"
  | "sqlite_busy"
  | "transport_close";

interface JsonRpcResponse {
  error?: { message?: string };
  id?: number | string;
  result?: unknown;
}

interface PendingRequest {
  reject: (err: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DbSnapshot {
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
  lockReleasedAt: number;
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
  lockControl: LockControlEvidence | null;
  maxSendSkewMs: number;
  postDb: DbSnapshot;
  preDb: DbSnapshot;
  processes: ProbeProcessResult[];
  round: number;
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
  args: string[];
  binary: string;
  concurrency: number;
  dbPath: string;
  minOverlap: number;
  outPath?: string;
  requireOverlap: boolean;
  rounds: number;
  sqliteLockControlMs: number;
  summarize?: boolean;
}

interface StartedClient {
  client: JsonRpcClient;
  index: number;
  pid: number;
  startAt: number;
}

interface InitializedClients {
  failures: ProbeProcessResult[];
  ready: StartedClient[];
  started: StartedClient[];
}

const BOOT_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 8_000;
const STDERR_TAIL_BYTES = 8_192;
const MAX_SEND_SKEW_MS = 25;

function nowMs(): number {
  return performance.now();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
}

class JsonRpcClient {
  private buffer = "";
  private readonly exitPromise: Promise<number | null>;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private stderr = "";

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    this.exitPromise = new Promise((resolve) => {
      this.proc.once("exit", (code) => {
        resolve(code);
      });
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk.toString("utf8"));
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(this.stderr, chunk);
    });
    this.proc.on("exit", () => {
      this.rejectAll(new Error("transport closed"));
    });
  }

  get pid(): number {
    return this.proc.pid ?? 0;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return this.proc.exitCode;
    }
    this.proc.stdin.end();
    const exitCode = await Promise.race([
      this.exitPromise,
      new Promise<null>((resolve) => {
        setTimeout(() => {
          this.proc.kill("SIGTERM");
          resolve(null);
        }, 1_000);
      }),
    ]);
    return exitCode;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = ++this.requestId;
    const body = JSON.stringify({ id, jsonrpc: "2.0", method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
    });
    this.proc.stdin.write(`${body}\n`);
    return promise;
  }

  private consumeStdout(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== "number") {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? "json-rpc error"));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private rejectAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(err);
    }
  }
}

function safeDbSnapshot(dbPath: string): DbSnapshot {
  const db = new Database(dbPath);
  try {
    const journalMode = readPragmaString(db, "journal_mode");
    const integrityCheck = readPragmaString(db, "integrity_check");
    return {
      integrityCheck,
      journalMode,
      sessionsRowCount: readSessionCount(db),
      walBytes: fileSize(`${dbPath}-wal`),
    };
  } finally {
    db.close();
  }
}

function readPragmaString(db: Database, name: string): string {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
  const value = row === null ? null : Object.values(row)[0];
  return nonEmptyString(value) ?? "";
}

function readSessionCount(db: Database): number {
  const table = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get();
  if (table === null) {
    return 0;
  }
  const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get();
  return row?.count ?? 0;
}

function readFixtureEvents(dbPath: string, round: number): ProbeFixtureEvent[] {
  const db = new Database(dbPath);
  try {
    const table = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe_events'")
      .get();
    if (table === null) {
      return [];
    }
    return db
      .query<
        { at_ms: number; kind: string; pid: number; round: number; session_id: string | null },
        [number]
      >(
        "SELECT kind, pid, round, session_id, at_ms FROM probe_events WHERE round = ? ORDER BY at_ms, pid",
      )
      .all(round)
      .map((row) => ({
        atMs: row.at_ms,
        kind: row.kind,
        pid: row.pid,
        round: row.round,
        sessionId: row.session_id,
      }));
  } finally {
    db.close();
  }
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function spawnClient(options: ProbeRunOptions, index: number): StartedClient {
  const startAt = nowMs();
  const proc = spawn(options.binary, options.args, {
    env: { ...process.env, DEVIN_CONTENTION_PROBE_INDEX: String(index) },
    shell: false,
    stdio: "pipe",
  });
  const client = new JsonRpcClient(proc);
  return { client, index, pid: client.pid, startAt };
}

function bootFailure(started: StartedClient, message: string): ProbeProcessResult {
  return {
    endAt: null,
    error: `boot_timeout: ${message}`,
    exitCode: null,
    index: started.index,
    pid: started.pid,
    sessionId: null,
    sessionNewResponseAt: 0,
    sessionNewSendAt: 0,
    startAt: started.startAt,
    stderrTail: started.client.stderrTail,
  };
}

async function initializeClient(
  started: StartedClient,
): Promise<{ failure: ProbeProcessResult; ready: null } | { failure: null; ready: StartedClient }> {
  try {
    await started.client.request("initialize", { clientInfo: { name: "probe" } }, BOOT_TIMEOUT_MS);
    return { failure: null, ready: started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { failure: bootFailure(started, message), ready: null };
  }
}

async function initializeClients(options: ProbeRunOptions): Promise<InitializedClients> {
  const started = Array.from({ length: options.concurrency }, (_, index) =>
    spawnClient(options, index),
  );
  const outcomes = await Promise.all(started.map((client) => initializeClient(client)));
  return {
    failures: outcomes.flatMap((outcome) => (outcome.failure === null ? [] : [outcome.failure])),
    ready: outcomes.flatMap((outcome) => (outcome.ready === null ? [] : [outcome.ready])),
    started,
  };
}

function extractSessionId(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const result = value as { sessionId?: unknown; session_id?: unknown };
  return nonEmptyString(result.sessionId) ?? nonEmptyString(result.session_id);
}

async function requestSession(started: StartedClient, round: number): Promise<ProbeProcessResult> {
  const sendAt = nowMs();
  try {
    const response = await started.client.request(
      "session/new",
      { cwd: process.cwd(), mcpServers: [], round },
      REQUEST_TIMEOUT_MS,
    );
    return {
      endAt: null,
      error: null,
      exitCode: null,
      index: started.index,
      pid: started.pid,
      sessionId: extractSessionId(response),
      sessionNewResponseAt: nowMs(),
      sessionNewSendAt: sendAt,
      startAt: started.startAt,
      stderrTail: started.client.stderrTail,
    };
  } catch (err) {
    return {
      endAt: null,
      error: err instanceof Error ? err.message : String(err),
      exitCode: null,
      index: started.index,
      pid: started.pid,
      sessionId: null,
      sessionNewResponseAt: nowMs(),
      sessionNewSendAt: sendAt,
      startAt: started.startAt,
      stderrTail: started.client.stderrTail,
    };
  }
}

async function releaseLockAfter(db: Database, holdMs: number): Promise<LockControlEvidence> {
  const lockAcquiredAt = nowMs();
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  db.run("COMMIT");
  return { lockAcquiredAt, lockReleasedAt: nowMs() };
}

function maxSendSkew(results: ProbeProcessResult[]): number {
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

function classifyRound(round: ProbeRoundResult, options: ProbeRunOptions): FailureClassification[] {
  const classes = classifyErrors(round.processes);
  const sessionIds = round.processes.flatMap((result) =>
    result.sessionId === null ? [] : [result.sessionId],
  );
  const uniqueSessionIds = new Set(sessionIds);

  if (sessionIds.length !== uniqueSessionIds.size) {
    classes.add("duplicate_session_id");
  }
  if (round.postDb.sessionsRowCount < round.preDb.sessionsRowCount + uniqueSessionIds.size) {
    classes.add("missing_session_rows");
  }
  if (options.requireOverlap && round.maxSendSkewMs > MAX_SEND_SKEW_MS) {
    classes.add("serialized_dispatch");
  }
  if (options.requireOverlap && maxIntervalOverlap(round.processes) < options.minOverlap) {
    classes.add("serialized_dispatch");
  }
  if (options.requireOverlap && fixtureReceiveSkew(round.fixtureEvents) > MAX_SEND_SKEW_MS) {
    classes.add("serialized_dispatch");
  }
  return [...classes].sort();
}

function fixtureReceiveSkew(events: ProbeFixtureEvent[]): number {
  const receivedAt = events
    .filter((event) => event.kind === "session_new_received")
    .map((event) => event.atMs);
  if (receivedAt.length < 2) {
    return 0;
  }
  return Math.max(...receivedAt) - Math.min(...receivedAt);
}

async function settleClients(
  clients: StartedClient[],
  results: ProbeProcessResult[],
): Promise<void> {
  await Promise.all(
    clients.map(async (started) => {
      const exitCode = await started.client.close();
      const match = results.find((result) => result.index === started.index);
      if (match !== undefined) {
        match.exitCode = exitCode;
        match.endAt = nowMs();
        match.stderrTail = started.client.stderrTail;
      }
    }),
  );
}

async function runRound(round: number, options: ProbeRunOptions): Promise<ProbeRoundResult> {
  const preDb = safeDbSnapshot(options.dbPath);
  const clients = await initializeClients(options);

  let lockDb: Database | null = null;
  let lockPromise: Promise<LockControlEvidence> | null = null;
  if (options.sqliteLockControlMs > 0) {
    lockDb = new Database(options.dbPath);
    lockDb.run("PRAGMA journal_mode=WAL");
    lockDb.run("BEGIN IMMEDIATE");
    lockPromise = releaseLockAfter(lockDb, options.sqliteLockControlMs);
  }

  const sessionResults = await Promise.all(
    clients.ready.map((client) => requestSession(client, round)),
  );
  const processes = [...sessionResults, ...clients.failures].sort((a, b) => a.index - b.index);
  const lockControl = lockPromise === null ? null : await lockPromise;
  if (lockDb !== null) {
    lockDb.close();
  }
  await settleClients(clients.started, processes);

  const partial: ProbeRoundResult = {
    classifications: [],
    fixtureEvents: readFixtureEvents(options.dbPath, round),
    lockControl,
    maxSendSkewMs: maxSendSkew(processes),
    postDb: safeDbSnapshot(options.dbPath),
    preDb,
    processes,
    round,
  };
  return { ...partial, classifications: classifyRound(partial, options) };
}

function rejectArtificialSleep(argv: string[]): void {
  const joined = argv.join(" ");
  if (/--pre-session-sleep-ms\b/i.test(joined)) {
    throw new Error("artificial per-agent sleep before session/new is rejected");
  }
  if (/(?:^|\s)(?:sleep|usleep)\s+\d+/i.test(joined)) {
    throw new Error("artificial per-agent sleep before session/new is rejected");
  }
  if (/sleep.*session\/new|session\/new.*sleep/i.test(joined)) {
    throw new Error("artificial per-agent sleep before session/new is rejected");
  }
}

function parseArgsValue(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("--args JSON value must be a string array");
    }
    const values: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") {
        throw new Error("--args JSON value must be a string array");
      }
      values.push(item);
    }
    return values;
  }
  return trimmed.split(/\s+/u);
}

function readCliFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) {
    return null;
  }
  return nonEmptyString(argv[index + 1]);
}

function readIntFlag(argv: string[], name: string, fallback: number): number {
  const value = readCliFlag(argv, name);
  if (value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --${name}: ${value}`);
  }
  return parsed;
}

export function parseProbeArgs(argv: string[]): ProbeRunOptions {
  rejectArtificialSleep(argv);
  const binary = readCliFlag(argv, "binary");
  const dbPath = readCliFlag(argv, "db");
  if (binary === null || dbPath === null) {
    throw new Error(
      "usage: devin-contention-probe --binary <path> --db <path> [--args '[...]'] [--rounds 3] [--concurrency 2]",
    );
  }
  const args = parseArgsValue(readCliFlag(argv, "args"));
  rejectArtificialSleep(args);
  return {
    args,
    binary,
    concurrency: readIntFlag(argv, "concurrency", 2),
    dbPath,
    minOverlap: readIntFlag(argv, "min-overlap", 2),
    outPath: readCliFlag(argv, "out") ?? undefined,
    requireOverlap: true,
    rounds: readIntFlag(argv, "rounds", 1),
    sqliteLockControlMs: readIntFlag(argv, "sqlite-lock-control-ms", 1_500),
    summarize: argv.includes("--summarize"),
  };
}

function assertSafeOptions(options: ProbeRunOptions): void {
  if (options.concurrency < 1 || options.rounds < 1) {
    throw new Error("rounds and concurrency must be >= 1");
  }
  if (options.minOverlap < 1 || options.minOverlap > options.concurrency) {
    throw new Error("--min-overlap must be between 1 and --concurrency");
  }
  rejectArtificialSleep([options.binary, ...options.args]);
}

function summarizeResult(
  rounds: ProbeRoundResult[],
  options: ProbeRunOptions,
): ProbeResult["summary"] {
  const classifications = new Set<FailureClassification>();
  for (const round of rounds) {
    for (const classification of round.classifications) {
      classifications.add(classification);
    }
  }
  return {
    classifications: [...classifications].sort(),
    concurrency: options.concurrency,
    rounds: options.rounds,
  };
}

export async function runDevinContentionProbe(options: ProbeRunOptions): Promise<ProbeResult> {
  assertSafeOptions(options);
  const rounds: ProbeRoundResult[] = [];
  for (let round = 0; round < options.rounds; round++) {
    rounds.push(await runRound(round, options));
  }
  const summary = summarizeResult(rounds, options);
  const result = {
    ok: summary.classifications.length === 0,
    rounds,
    summary,
  };
  if (options.outPath !== undefined) {
    writeFileSync(options.outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (import.meta.main) {
  const options = parseProbeArgs(process.argv.slice(2));
  runDevinContentionProbe(options)
    .then((result) => {
      const output = options.summarize === true ? result.summary : result;
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
