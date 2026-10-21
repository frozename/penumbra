import { getJobResourceEnv } from "@penumbra/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { createLogger } from "../logger.js";

export type ResourceScopeMode = "auto" | "off" | "on";

export interface ResourceScopeConfig {
  mode: ResourceScopeMode;
  memoryHigh: string;
  memoryMax: string;
  swapMax: string;
  oomScoreAdj: number;
}

/** Host facts needed to build a `systemd-run --user --scope` argv. */
export interface ResourceScopeHost {
  systemdRun: string;
  envBin: string;
  choom: string | null;
  /** XDG_RUNTIME_DIR that reaches the user manager's private socket. */
  runtimeDir: string;
  /** The caller's own user unit; job scopes stop with it (stop, restart and crash). */
  bindUnit: string | null;
}

export type ResourceScopeDetection =
  | { available: true; host: ResourceScopeHost }
  | { available: false; reason: string };

export interface ResourceScopeDetectDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  uid?: number;
}

export interface WrapResourceScopeOptions {
  /** Short job label used in the transient unit name, e.g. "reconcile-bun". */
  label?: string;
  /**
   * The env the wrapped argv is spawned with (default: this process's env).
   * When it lacks XDG_RUNTIME_DIR (e.g. the sandboxed terminal env), the
   * wrapper hands it to systemd-run only and strips it again before the job runs.
   */
  childEnv?: Readonly<Record<string, string | undefined>>;
  config?: ResourceScopeConfig;
  /** Pre-resolved host, or null to force the bare argv (test seam). */
  host?: ResourceScopeHost | null;
}

const FALLBACK_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];
const PROBE_TIMEOUT_MS = 10_000;
const log = createLogger({ component: "resource-scope" });

let detection: ResourceScopeDetection | undefined;
let warnedUnavailable = false;
let warnedNoChoom = false;

export function resolveResourceScopeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResourceScopeConfig {
  const parsed = getJobResourceEnv(env);
  return {
    mode: parsed.scope,
    memoryHigh: parsed.memoryHigh,
    memoryMax: parsed.memoryMax,
    swapMax: parsed.swapMax,
    oomScoreAdj: parsed.oomScoreAdj,
  };
}

function findBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...FALLBACK_BIN_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The caller's own unit in the user manager, from a cgroup v2 path such as
 * `0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-worker.service`.
 * Units outside `user@<uid>.service` belong to the system manager and cannot be
 * bound from a `--user` scope.
 */
export function parseOwnUserUnit(cgroupText: string, uid: number): string | null {
  const line = cgroupText.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const segments = line.slice(3).split("/").filter(Boolean);
  const managerIdx = segments.indexOf(`user@${String(uid)}.service`);
  if (managerIdx === -1) return null;
  const unit = segments
    .slice(managerIdx + 1)
    .findLast((segment) => /^[\w:.\\-]+\.(?:service|scope)$/.test(segment));
  return unit ?? null;
}

export function detectResourceScopeHost(
  deps: ResourceScopeDetectDeps = {},
): ResourceScopeDetection {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return { available: false, reason: `platform=${platform}` };
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const systemdRun = findBinary("systemd-run", env, exists);
  if (!systemdRun) return { available: false, reason: "systemd-run not found on PATH" };
  const envBin = findBinary("env", env, exists);
  if (!envBin) return { available: false, reason: "env not found on PATH" };
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${String(uid)}`;
  if (!exists(join(runtimeDir, "systemd", "private"))) {
    return { available: false, reason: `user manager not reachable under ${runtimeDir}` };
  }
  let cgroupText = "";
  try {
    const read = deps.readFile ?? ((p: string): string => readFileSync(p, "utf8"));
    cgroupText = read("/proc/self/cgroup");
  } catch {
    // An unreadable cgroup only loses lifetime binding; scoping still works.
  }
  return {
    available: true,
    host: {
      systemdRun,
      envBin,
      choom: findBinary("choom", env, exists),
      runtimeDir,
      bindUnit: parseOwnUserUnit(cgroupText, uid),
    },
  };
}

function scopeUnitName(label: string): string {
  const safe = label.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "job";
  return `penumbra-${safe}-${randomBytes(4).toString("hex")}`;
}

/**
 * Builds the scoped argv. Every step execs in place (env, systemd-run --scope,
 * choom), so the spawned pid and its process group are the job's own and
 * existing group kills keep working. A trailing env/choom keeps exit code 127
 * for a missing executable, which systemd-run itself reports as 1.
 */
export function buildResourceScopeArgv(
  argv: readonly string[],
  host: ResourceScopeHost,
  config: ResourceScopeConfig,
  opts: { label?: string; childEnv?: Readonly<Record<string, string | undefined>> } = {},
): string[] {
  const label = opts.label ?? "job";
  const needsRuntimeDir =
    opts.childEnv !== undefined && (opts.childEnv.XDG_RUNTIME_DIR ?? "") === "";
  const out: string[] = needsRuntimeDir ? [host.envBin, `XDG_RUNTIME_DIR=${host.runtimeDir}`] : [];
  out.push(
    host.systemdRun,
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    `--unit=${scopeUnitName(label)}`,
    `--description=penumbra job (${label})`,
    "-p",
    `MemoryHigh=${config.memoryHigh}`,
    "-p",
    `MemoryMax=${config.memoryMax}`,
    "-p",
    `MemorySwapMax=${config.swapMax}`,
  );
  if (host.bindUnit) {
    out.push("-p", `BindsTo=${host.bindUnit}`, "-p", `StopPropagatedFrom=${host.bindUnit}`);
  }
  out.push("--");
  if (needsRuntimeDir) out.push(host.envBin, "-u", "XDG_RUNTIME_DIR");
  if (config.oomScoreAdj > 0 && host.choom) {
    out.push(host.choom, "-n", String(config.oomScoreAdj), "--");
  } else if (!needsRuntimeDir) {
    out.push(host.envBin);
  }
  out.push(...argv);
  return out;
}

function warnUnavailableOnce(config: ResourceScopeConfig, reason: string): void {
  if (warnedUnavailable) return;
  if (config.mode === "auto" && reason.startsWith("platform=")) return;
  warnedUnavailable = true;
  log.warn(
    { mode: config.mode, reason },
    "job resource scopes unavailable; running jobs without a memory cap",
  );
}

// Scopes reject OOMScoreAdjust= (systemd 255), so the score is raised by choom
// inside the scope; without it jobs still get the memory cap, at the default score.
function warnNoChoomOnce(host: ResourceScopeHost, config: ResourceScopeConfig): void {
  if (warnedNoChoom || host.choom !== null || config.oomScoreAdj <= 0) return;
  warnedNoChoom = true;
  log.warn(
    { oom_score_adj: config.oomScoreAdj },
    "choom not found; scoped jobs keep the default oom_score_adj",
  );
}

function currentDetection(): ResourceScopeDetection {
  detection ??= detectResourceScopeHost();
  return detection;
}

/**
 * Wraps argv in a memory-capped transient user scope when PENUMBRA_JOB_SCOPE
 * allows it and the host supports it; otherwise returns argv unchanged (one
 * warning per process).
 */
export function wrapResourceScopeArgv(
  argv: readonly string[],
  opts: WrapResourceScopeOptions = {},
): string[] {
  const config = opts.config ?? resolveResourceScopeConfig();
  if (config.mode === "off") return [...argv];
  let host: ResourceScopeHost | null;
  if (opts.host !== undefined) {
    host = opts.host;
  } else {
    const found = currentDetection();
    if (!found.available) warnUnavailableOnce(config, found.reason);
    host = found.available ? found.host : null;
  }
  if (!host) return [...argv];
  warnNoChoomOnce(host, config);
  // A spawn without an explicit env inherits ours.
  return buildResourceScopeArgv(argv, host, config, {
    label: opts.label,
    childEnv: opts.childEnv ?? process.env,
  });
}

type ProbeSpawn = (
  argv: string[],
) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }>;

function defaultProbeSpawn(argv: string[]): ReturnType<ProbeSpawn> {
  return new Promise((resolve) => {
    const [file = "", ...args] = argv;
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stderr: err.message });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stderr });
    });
  });
}

/**
 * Runs the exact scope argv once against `true` and caches the verdict, so a
 * systemd too old for a property (or an unreachable bus) disables scoping with
 * one warning instead of failing every job. Call once at worker/daemon start.
 */
export async function primeResourceScope(
  opts: { config?: ResourceScopeConfig; deps?: ResourceScopeDetectDeps; spawn?: ProbeSpawn } = {},
): Promise<ResourceScopeDetection> {
  const config = opts.config ?? resolveResourceScopeConfig();
  if (config.mode === "off") return { available: false, reason: "PENUMBRA_JOB_SCOPE=off" };
  const found = detectResourceScopeHost(opts.deps);
  if (!found.available) {
    detection = found;
    warnUnavailableOnce(config, found.reason);
    return found;
  }
  const argv = buildResourceScopeArgv(["true"], found.host, config, {
    label: "probe",
    childEnv: process.env,
  });
  const res = await (opts.spawn ?? defaultProbeSpawn)(argv);
  if (res.exitCode === 0) {
    detection = found;
    warnNoChoomOnce(found.host, config);
    log.info(
      { bind_unit: found.host.bindUnit, choom: found.host.choom !== null, ...config },
      "job resource scopes enabled",
    );
    return found;
  }
  const failed: ResourceScopeDetection = {
    available: false,
    reason: `probe failed (exit=${String(res.exitCode)}): ${res.stderr.trim().slice(0, 500)}`,
  };
  detection = failed;
  warnUnavailableOnce(config, failed.reason);
  return failed;
}

export function resetResourceScopeForTest(): void {
  detection = undefined;
  warnedUnavailable = false;
  warnedNoChoom = false;
}

export interface JobExitInfo {
  exitCode: number | null;
  signal: string | null;
  /** True when Penumbra itself killed the job (timeout, output overflow, cancel). */
  killedByPenumbra?: boolean;
}

/**
 * A SIGKILL (or a shell's 128+9) that Penumbra did not send is how a scope's
 * MemoryMax OOM kill — or a global OOM kill — reaches the parent.
 */
export function isResourceKill(info: JobExitInfo): boolean {
  if (info.killedByPenumbra === true) return false;
  return info.signal === "SIGKILL" || info.exitCode === 137;
}

const SCOPE_LAUNCH_FAILURE_RE =
  /^(?:Failed to (?:start transient scope unit|connect to bus|create bus connection)|Unknown assignment)/m;

/** systemd-run's own failure (exit 1) before the job ever started. */
export function isResourceScopeLaunchFailure(stderr: string): boolean {
  return SCOPE_LAUNCH_FAILURE_RE.test(stderr);
}
