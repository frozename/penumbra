export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Aborting sends the child SIGTERM. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Exit code; 127 when the binary could not be spawned, 124 on timeout. */
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (argv: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface HttpResponse {
  status: number;
  text: string;
}

export type Http = (
  url: string,
  init?: { headers?: Record<string, string>; timeoutMs?: number },
) => Promise<HttpResponse>;

export interface FsPort {
  readText(path: string): Promise<string | null>;
  /** Appends, creating parent directories. */
  appendText(path: string, text: string): Promise<void>;
  size(path: string): Promise<number | null>;
  /** Text from byte `offset` to the end (bounded to the last few MiB). */
  readFrom(path: string, offset: number): Promise<string>;
  realpath(path: string): Promise<string>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface HostChild {
  pid: number;
  /** Process age in seconds; null when it cannot be determined. */
  ageS: number | null;
  argv: string[];
}

export interface HostPort {
  platform: NodeJS.Platform;
  uid: number;
  pid: number;
  selfCgroup(): Promise<string | null>;
  parentPid(pid: number): Promise<number | null>;
  /** Direct children of `pid` as "pid name" strings. */
  children(pid: number): Promise<string[]>;
  /** Direct children of `pid` with age and full command line. */
  childProcesses(pid: number): Promise<HostChild[]>;
}

export interface GitPort {
  topLevel(): Promise<string>;
  /** Current branch, or null on a detached HEAD. */
  branch(): Promise<string | null>;
  fetch(ref: string): Promise<void>;
  /** Full commit sha, or null when `ref` does not name a commit. */
  resolve(ref: string): Promise<string | null>;
  head(): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  log(from: string, to: string, limit: number): Promise<{ count: number; lines: string[] }>;
  depsChanged(from: string, to: string): Promise<boolean>;
  trackedChanges(): Promise<string[]>;
  fastForward(to: string): Promise<void>;
  resetHard(to: string): Promise<void>;
}

/** Conclusion of the target's `check` workflow run: success, failure, cancelled, … */
export type CiState = string;

export interface CiPort {
  state(sha: string): Promise<CiState>;
}

export interface DaemonHealth {
  ok: boolean;
  port: number | null;
  detail: string;
}

export interface DispatchedHandoff {
  handoffId: string;
  agent: string;
  workerId: string | null;
}

export type InFlight =
  | { ok: true; dispatched: DispatchedHandoff[]; approved: number }
  | { ok: false; error: string };

export interface DaemonPort {
  health(): Promise<DaemonHealth>;
  inFlight(): Promise<InFlight>;
}

export type LogSource =
  | { kind: "file"; path: string }
  | { kind: "journal"; unit: string }
  | { kind: "none"; reason: string };

export type LogCursor = { kind: "offset"; value: number } | { kind: "since"; value: number };

export interface LogReader {
  cursor(source: LogSource): Promise<LogCursor>;
  readSince(source: LogSource, cursor: LogCursor): Promise<string>;
}

export type ServiceManagerKind = "launchd" | "systemd";

export interface ServiceUnitState {
  /** systemd unit or launchd label. */
  name: string;
  loaded: boolean;
  active: boolean;
  pid: number | null;
  workingDirectory: string | null;
  argv: string[];
  environment: Record<string, string>;
}

export interface RuntimeState {
  daemon: ServiceUnitState;
  worker: ServiceUnitState;
}

export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  readonly daemonName: string;
  readonly workerName: string;
  /** True when the worker can be stopped to stop new claims (systemd). */
  readonly canFreeze: boolean;
  state(): Promise<RuntimeState>;
  logSource(which: "daemon" | "worker"): Promise<LogSource>;
  /** Live Penumbra job scopes, excluding `penumbra-update*`. */
  jobScopes(): Promise<string[]>;
  /** BindsTo= of a unit, or null when it cannot be read. */
  bindsTo(unit: string): Promise<string[] | null>;
  freeze(): Promise<void>;
  unfreeze(): Promise<void>;
  /** Restart the daemon, then (re)start the worker. */
  restart(): Promise<void>;
}

export interface InstallResult {
  ok: boolean;
  /** False when bun never started, so node_modules is untouched. */
  ran: boolean;
  detail: string;
}

export interface InstallLease {
  release(): Promise<void>;
}

export type InstallGate = { ok: true; lease: InstallLease } | { ok: false; detail: string };

export interface InstallPort {
  /** The host heavy-job lock plus the memory admission floor; may wait a long time. */
  acquire(): Promise<InstallGate>;
  /** `bun install --frozen-lockfile`; the caller holds a lease from acquire(). */
  run(repo: string, signal?: AbortSignal): Promise<InstallResult>;
}

/** Registers SIGINT/SIGTERM/SIGHUP handling; returns the unregister function. */
export type OnSignal = (handler: (signal: string) => void) => () => void;

export type UpdateMode = "apply" | "check" | "rollback";

export interface UpdateOptions {
  mode: UpdateMode;
  ref: string;
  rollbackSha: string | null;
  allowRedCi: boolean;
  waitIdleS: number;
  verifyTimeoutS: number;
  json: boolean;
  repo: string | null;
  serviceManager: "auto" | ServiceManagerKind;
  daemonUnit: string;
  workerUnit: string;
  daemonLabel: string;
  workerLabel: string;
}

export interface HeavyLockInfo {
  path: string;
  source: "default" | "env" | "worker-unit";
}

export interface UpdateContext {
  options: UpdateOptions;
  storageRoot: string;
  repo: string;
  historyPath: string;
  git: GitPort;
  ci: CiPort;
  daemon: DaemonPort;
  host: HostPort;
  fs: FsPort;
  logs: LogReader;
  install: InstallPort;
  clock: Clock;
  manager: ServiceManager | null;
  managerReason: string | null;
  heavyLock: HeavyLockInfo;
  /** The services' bun (ExecStart), else the one running this CLI. */
  bunPath: string;
  /** Environment and home of the CLI process; resolves the seat config path. */
  env: NodeJS.ProcessEnv;
  home: string;
  onSignal: OnSignal;
  exit: (code: number) => void;
  /** Progress line (stderr under --json). */
  say: (line: string) => void;
}

export class UpdateError extends Error {
  override readonly name = "UpdateError";
}

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_ROLLED_BACK = 3;
export const EXIT_NEEDS_OPERATOR = 4;
