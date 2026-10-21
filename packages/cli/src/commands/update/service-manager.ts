import {
  type Exec,
  type ExecResult,
  type LogSource,
  type ServiceManager,
  type ServiceManagerKind,
  type ServiceUnitState,
  UpdateError,
} from "./types.js";

const SYSTEMCTL_TIMEOUT_MS = 120_000;
const SHOW_PROPERTIES = "LoadState,ActiveState,MainPID,WorkingDirectory,ExecStart,Environment";

export interface ServiceNames {
  daemonUnit: string;
  workerUnit: string;
  daemonLabel: string;
  workerLabel: string;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function ensureOk(res: ExecResult, what: string): ExecResult {
  if (res.code !== 0) {
    throw new UpdateError(`${what} failed (exit ${String(res.code)}): ${firstLine(res.stderr)}`);
  }
  return res;
}

export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/** argv from a `systemctl show -p ExecStart` value: `{ path=… ; argv[]=a b c ; … }`. */
export function parseExecStartArgv(value: string): string[] {
  const match = /argv\[\]=([^;]*)/.exec(value);
  return (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
}

/** `Environment=A=1 "B=two words"` as a record (systemd quotes entries with spaces). */
export function parseSystemdEnvironment(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/g)) {
    const entry = match[1] ?? match[2] ?? "";
    const idx = entry.indexOf("=");
    if (idx > 0) out[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return out;
}

function expandSpecifiers(value: string, home: string): string | null {
  const expanded = value.replaceAll("%h", home).replaceAll("%%", "\u0000");
  if (expanded.includes("%")) return null;
  return expanded.replaceAll("\u0000", "%");
}

/** Where a unit's stdout goes, from `systemctl cat` (the last StandardOutput= wins). */
export function parseSystemdLogTarget(unitText: string, unit: string, home: string): LogSource {
  let value: string | null = null;
  for (const line of unitText.split("\n")) {
    const match = /^StandardOutput=(.*)$/.exec(line.trim());
    if (match) value = (match[1] ?? "").trim();
  }
  if (value === null || value === "" || value === "inherit" || value.startsWith("journal")) {
    return { kind: "journal", unit };
  }
  const file = /^(?:append|file|truncate):(.+)$/.exec(value)?.[1];
  if (!file) return { kind: "none", reason: `StandardOutput=${value}` };
  const path = expandSpecifiers(file, home);
  return path === null
    ? { kind: "none", reason: `unsupported specifier in StandardOutput=${value}` }
    : { kind: "file", path };
}

function cleanWorkingDirectory(value: string | undefined, home: string): string | null {
  const dir = (value ?? "").replace(/^[!-]/, "");
  if (dir === "") return null;
  return dir === "~" ? home : dir;
}

export function systemdUnitState(
  unit: string,
  props: Record<string, string>,
  home: string,
): ServiceUnitState {
  const pid = Number(props.MainPID ?? "0");
  return {
    name: unit,
    loaded: props.LoadState === "loaded",
    active: props.ActiveState === "active",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    workingDirectory: cleanWorkingDirectory(props.WorkingDirectory, home),
    argv: parseExecStartArgv(props.ExecStart ?? ""),
    environment: parseSystemdEnvironment(props.Environment ?? ""),
  };
}

export function createSystemdManager(
  exec: Exec,
  names: ServiceNames,
  home: string,
): ServiceManager {
  const systemctl = async (args: string[]): Promise<ExecResult> =>
    await exec(["systemctl", "--user", ...args], { timeoutMs: SYSTEMCTL_TIMEOUT_MS });
  const run = async (args: string[]): Promise<void> => {
    ensureOk(await systemctl(args), `systemctl --user ${args.join(" ")}`);
  };
  const show = async (unit: string): Promise<ServiceUnitState> => {
    const res = ensureOk(
      await systemctl(["show", unit, "-p", SHOW_PROPERTIES]),
      `systemctl --user show ${unit}`,
    );
    return systemdUnitState(unit, parseKeyValues(res.stdout), home);
  };
  const manager: ServiceManager = {
    kind: "systemd",
    daemonName: names.daemonUnit,
    workerName: names.workerUnit,
    canFreeze: true,
    state: async () => {
      const [daemon, worker] = await Promise.all([show(names.daemonUnit), show(names.workerUnit)]);
      return { daemon, worker };
    },
    logSource: async (which) => {
      const unit = which === "daemon" ? names.daemonUnit : names.workerUnit;
      const res = await systemctl(["cat", unit]);
      if (res.code !== 0) return { kind: "none", reason: `systemctl --user cat ${unit} failed` };
      return parseSystemdLogTarget(res.stdout, unit, home);
    },
    jobScopes: async () => {
      const res = await systemctl([
        "list-units",
        "--type=scope",
        "--state=active",
        "--no-legend",
        "--plain",
        "penumbra-*.scope",
      ]);
      ensureOk(res, "systemctl --user list-units penumbra-*.scope");
      return res.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter((name) => name.startsWith("penumbra-") && name.endsWith(".scope"))
        .filter((name) => !name.startsWith("penumbra-update"));
    },
    bindsTo: async (unit) => {
      const res = await systemctl(["show", unit, "-p", "BindsTo", "--value"]);
      return res.code === 0 ? res.stdout.trim().split(/\s+/).filter(Boolean) : null;
    },
    freeze: async () => {
      await run(["stop", names.workerUnit]);
    },
    unfreeze: async () => {
      await run(["start", names.workerUnit]);
    },
    restart: async () => {
      await run(["restart", names.daemonUnit]);
      await run(["start", names.workerUnit]);
    },
  };
  return manager;
}

function readBlock(lines: string[], start: number): string[] {
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "}") break;
    if (line !== "") out.push(line);
  }
  return out;
}

function blockAfter(lines: string[], header: RegExp): string[] {
  const idx = lines.findIndex((line) => header.test(line));
  return idx === -1 ? [] : readBlock(lines, idx);
}

function launchdField(text: string, field: string): string | null {
  const match = new RegExp(`^\\s*${field} = (.+)$`, "m").exec(text);
  return match?.[1]?.trim() ?? null;
}

export interface LaunchdPrint extends ServiceUnitState {
  stdoutPath: string | null;
}

/** Parses `launchctl print gui/<uid>/<label>` (exit code 0 = loaded). */
export function parseLaunchdPrint(label: string, text: string, loaded: boolean): LaunchdPrint {
  const lines = text.split("\n");
  const pid = Number(launchdField(text, "pid") ?? "0");
  const environment: Record<string, string> = {};
  for (const entry of blockAfter(lines, /^\s*environment = \{/)) {
    const [key, ...rest] = entry.split(" => ");
    if (key && rest.length > 0) environment[key.trim()] = rest.join(" => ").trim();
  }
  return {
    name: label,
    loaded,
    active: loaded && launchdField(text, "state") === "running",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    workingDirectory: launchdField(text, "working directory"),
    argv: blockAfter(lines, /^\s*arguments = \{/),
    environment,
    stdoutPath: launchdField(text, "stdout path"),
  };
}

export function createLaunchdManager(exec: Exec, names: ServiceNames, uid: number): ServiceManager {
  const target = (label: string): string => `gui/${String(uid)}/${label}`;
  const print = async (label: string): Promise<LaunchdPrint> => {
    const res = await exec(["launchctl", "print", target(label)], { timeoutMs: 30_000 });
    if (res.code === 127) {
      throw new UpdateError(`launchctl not available: ${firstLine(res.stderr)}`);
    }
    return parseLaunchdPrint(label, res.stdout, res.code === 0);
  };
  const kickstart = async (label: string): Promise<void> => {
    const res = await exec(["launchctl", "kickstart", "-k", target(label)], {
      timeoutMs: SYSTEMCTL_TIMEOUT_MS,
    });
    ensureOk(res, `launchctl kickstart -k ${target(label)}`);
  };
  const manager: ServiceManager = {
    kind: "launchd",
    daemonName: names.daemonLabel,
    workerName: names.workerLabel,
    canFreeze: false,
    state: async () => {
      const [daemon, worker] = await Promise.all([
        print(names.daemonLabel),
        print(names.workerLabel),
      ]);
      return { daemon, worker };
    },
    logSource: async (which) => {
      const printed = await print(which === "daemon" ? names.daemonLabel : names.workerLabel);
      return printed.stdoutPath
        ? { kind: "file", path: printed.stdoutPath }
        : { kind: "none", reason: "no stdout path in launchctl print" };
    },
    jobScopes: () => Promise.resolve([]),
    bindsTo: () => Promise.resolve(null),
    freeze: () => Promise.resolve(),
    unfreeze: () => Promise.resolve(),
    restart: async () => {
      await kickstart(names.daemonLabel);
      await kickstart(names.workerLabel);
    },
  };
  return manager;
}

export interface ManagerSelection {
  manager: ServiceManager | null;
  reason: string | null;
}

export interface SelectManagerOpts {
  choice: "auto" | ServiceManagerKind;
  platform: NodeJS.Platform;
  exec: Exec;
  uid: number;
  home: string;
  names: ServiceNames;
}

function resolveKind(
  choice: SelectManagerOpts["choice"],
  platform: NodeJS.Platform,
): ServiceManagerKind | null {
  if (choice !== "auto") return choice;
  if (platform === "linux") return "systemd";
  if (platform === "darwin") return "launchd";
  return null;
}

function describeKind(kind: ServiceManagerKind): string {
  return kind === "systemd" ? "systemd --user" : "launchd (gui domain)";
}

/** Picks the service manager that runs the daemon + worker; never guesses past what is loaded. */
export async function selectServiceManager(opts: SelectManagerOpts): Promise<ManagerSelection> {
  const kind = resolveKind(opts.choice, opts.platform);
  if (kind === null) {
    return { manager: null, reason: `no supported service manager on platform=${opts.platform}` };
  }
  const manager =
    kind === "systemd"
      ? createSystemdManager(opts.exec, opts.names, opts.home)
      : createLaunchdManager(opts.exec, opts.names, opts.uid);
  let missing: string[];
  try {
    const state = await manager.state();
    missing = [state.daemon, state.worker].filter((unit) => !unit.loaded).map((unit) => unit.name);
  } catch (err) {
    return {
      manager: null,
      reason: `${describeKind(kind)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (missing.length > 0) {
    return { manager: null, reason: `${describeKind(kind)} has no ${missing.join(" or ")} loaded` };
  }
  return { manager, reason: null };
}
