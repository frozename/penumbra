import { getUpdateEnv, type UpdateEnv } from "@penumbra/config";
import { resolve } from "node:path";

import type { UpdateOptions } from "./types.js";

export const UPDATE_USAGE = `usage: penumbra update [--check | --apply | --rollback [sha]] [options]

Safe self-update for a source install (a git checkout run with bun by
systemd --user or launchd). Default is --check.

  --check              read-only (apart from git fetch): current -> target, new
                       commits, dependency changes, target CI, runtime activity
  --apply              fast-forward to the target, bun install if bun.lock or a
                       package.json changed, restart the daemon and worker, verify;
                       rolls back automatically when verification fails
  --rollback [sha]     go back to sha (default: the last from= in
                       <storage root>/update-history.log), same procedure

options:
  --ref <ref>              target (default origin/main)
  --allow-red-ci           apply even when the target's check run is not green
  --wait-idle <s>          wait up to s seconds for in-flight dispatches (default 900)
  --verify-timeout <s>     health wait after the restart (default 120)
  --repo <path>            checkout to update (default: the one running this CLI)
  --service-manager <m>    auto | systemd | launchd   (PENUMBRA_UPDATE_SERVICE_MANAGER)
  --daemon-unit <unit>     systemd unit   (PENUMBRA_UPDATE_DAEMON_UNIT, penumbra-daemon.service)
  --worker-unit <unit>     systemd unit   (PENUMBRA_UPDATE_WORKER_UNIT, penumbra-worker.service)
  --daemon-label <label>   launchd label  (PENUMBRA_UPDATE_DAEMON_LABEL, dev.penumbra.daemon)
  --worker-label <label>   launchd label  (PENUMBRA_UPDATE_WORKER_LABEL, dev.penumbra.worker)
  --json                   machine-readable result on stdout (progress on stderr)

exit codes: 0 ok / up to date, 1 refused (nothing changed), 2 usage,
            3 update failed and was rolled back, 4 runtime needs attention`;

export type ParsedOptions =
  | { ok: true; options: UpdateOptions }
  | { ok: false; error: string }
  | { ok: "help" };

const VALUE_FLAGS = new Set([
  "--ref",
  "--wait-idle",
  "--verify-timeout",
  "--repo",
  "--service-manager",
  "--daemon-unit",
  "--worker-unit",
  "--daemon-label",
  "--worker-label",
]);
const MODE_FLAGS: Record<string, UpdateOptions["mode"]> = {
  "--check": "check",
  "--apply": "apply",
  "--rollback": "rollback",
};
const BOOL_FLAGS = new Set(["--allow-red-ci", "--json"]);

interface Scan {
  values: Map<string, string>;
  bools: Set<string>;
  modes: UpdateOptions["mode"][];
  rollbackSha: string | null;
}

/** Consumes the argument at `i`; returns how many were used, or an error. */
function consumeArg(args: string[], i: number, scan: Scan): number | string {
  const arg = args[i] ?? "";
  const next = args[i + 1];
  const mode = MODE_FLAGS[arg];
  if (mode) {
    scan.modes.push(mode);
    if (mode !== "rollback" || next === undefined || !/^[0-9a-f]{7,40}$/.test(next)) return 1;
    scan.rollbackSha = next;
    return 2;
  }
  if (BOOL_FLAGS.has(arg)) {
    scan.bools.add(arg);
    return 1;
  }
  if (!VALUE_FLAGS.has(arg)) return `unknown argument: ${arg}`;
  if (next === undefined || next.startsWith("--")) return `${arg} requires a value`;
  scan.values.set(arg, next);
  return 2;
}

function scanArgs(args: string[]): Scan | string {
  const scan: Scan = { values: new Map(), bools: new Set(), modes: [], rollbackSha: null };
  for (let i = 0; i < args.length; ) {
    const used = consumeArg(args, i, scan);
    if (typeof used === "string") return used;
    i += used;
  }
  return scan;
}

type Field<T> = { value: T } | { error: string };

function seconds(scan: Scan, flag: string, fallback: number): Field<number> {
  const raw = scan.values.get(flag);
  if (raw === undefined) return { value: fallback };
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? { value }
    : { error: `${flag} must be a non-negative integer (got ${raw})` };
}

function serviceManagerChoice(
  scan: Scan,
  fallback: UpdateOptions["serviceManager"],
): Field<UpdateOptions["serviceManager"]> {
  const raw = scan.values.get("--service-manager");
  if (raw === undefined) return { value: fallback };
  return raw === "auto" || raw === "systemd" || raw === "launchd"
    ? { value: raw }
    : { error: `--service-manager must be auto, systemd or launchd (got ${raw})` };
}

function checkNames(options: UpdateOptions): string | null {
  for (const unit of [options.daemonUnit, options.workerUnit]) {
    if (!/^[\w:.@-]+\.service$/.test(unit)) return `not a systemd service unit: ${unit}`;
  }
  for (const label of [options.daemonLabel, options.workerLabel]) {
    if (!/^[\w.-]+$/.test(label)) return `not a launchd label: ${label}`;
  }
  return null;
}

function loadDefaults(env: NodeJS.ProcessEnv): Field<UpdateEnv> {
  try {
    return { value: getUpdateEnv(env) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `invalid PENUMBRA_UPDATE_* setting: ${detail}` };
  }
}

function buildOptions(scan: Scan, defaults: UpdateEnv, cwd: string): Field<UpdateOptions> {
  const waitIdleS = seconds(scan, "--wait-idle", 900);
  const verifyTimeoutS = seconds(scan, "--verify-timeout", 120);
  const serviceManager = serviceManagerChoice(scan, defaults.serviceManager);
  if ("error" in waitIdleS) return waitIdleS;
  if ("error" in verifyTimeoutS) return verifyTimeoutS;
  if ("error" in serviceManager) return serviceManager;
  const repo = scan.values.get("--repo");
  const options: UpdateOptions = {
    mode: scan.modes[0] ?? "check",
    ref: scan.values.get("--ref") ?? "origin/main",
    rollbackSha: scan.rollbackSha,
    allowRedCi: scan.bools.has("--allow-red-ci"),
    waitIdleS: waitIdleS.value,
    verifyTimeoutS: verifyTimeoutS.value,
    json: scan.bools.has("--json"),
    repo: repo === undefined ? null : resolve(cwd, repo),
    serviceManager: serviceManager.value,
    daemonUnit: scan.values.get("--daemon-unit") ?? defaults.daemonUnit,
    workerUnit: scan.values.get("--worker-unit") ?? defaults.workerUnit,
    daemonLabel: scan.values.get("--daemon-label") ?? defaults.daemonLabel,
    workerLabel: scan.values.get("--worker-label") ?? defaults.workerLabel,
  };
  const badName = checkNames(options);
  return badName ? { error: badName } : { value: options };
}

export function parseUpdateArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ParsedOptions {
  if (args.includes("--help") || args.includes("-h")) return { ok: "help" };
  const scan = scanArgs(args);
  if (typeof scan === "string") return { ok: false, error: scan };
  if (scan.modes.length > 1) {
    return { ok: false, error: "--check, --apply and --rollback are exclusive" };
  }
  const defaults = loadDefaults(env);
  if ("error" in defaults) return { ok: false, error: defaults.error };
  const options = buildOptions(scan, defaults.value, cwd);
  return "error" in options
    ? { ok: false, error: options.error }
    : { ok: true, options: options.value };
}
