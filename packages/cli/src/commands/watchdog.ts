import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DAEMON_LABEL = "dev.penumbra.daemon";
const WATCHDOG_RECORD_FILE = "watchdog.jsonl";

export type WatchdogStatus =
  | "healthy"
  | "service_absent"
  | "service_present_unhealthy"
  | "launchctl_unknown";

export type WatchdogAction = "none" | "bootstrap" | "kickstart";

export interface WatchdogResult {
  status: WatchdogStatus;
  action: WatchdogAction;
  actionExitCode: number | null;
  actionError: string | null;
  observedAt: string;
  downSince: string | null;
  downtimeMs: number;
  recordPath: string;
}

export interface LaunchctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WatchdogDependencies {
  now: () => Date;
  probeDaemon: () => Promise<boolean>;
  launchctl: (args: string[]) => Promise<LaunchctlResult>;
  uid: () => number;
  plistPath: string;
  error: (message: string) => void;
}

export interface RunWatchdogOptions {
  storageRoot: string;
  heal?: boolean;
  dependencies?: Partial<WatchdogDependencies>;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve watchdog orchestration while grandfathering its pre-existing complexity.
export async function runWatchdog(opts: RunWatchdogOptions): Promise<WatchdogResult> {
  const dependencies: WatchdogDependencies = {
    now: () => new Date(),
    probeDaemon: () => probeDaemonHealth(opts.storageRoot),
    launchctl: runLaunchctl,
    uid: () => process.getuid?.() ?? 0,
    plistPath: join(homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`),
    error: (message) => {
      console.error(message);
    },
    ...opts.dependencies,
  };
  const observedAt = dependencies.now().toISOString();
  const recordPath = join(opts.storageRoot, WATCHDOG_RECORD_FILE);

  if (await dependencies.probeDaemon()) {
    const priorDownSince = readActiveDownSince(recordPath);
    const result: WatchdogResult = {
      status: "healthy",
      action: "none",
      actionExitCode: null,
      actionError: null,
      observedAt,
      downSince: priorDownSince,
      downtimeMs: priorDownSince
        ? Math.max(0, Date.parse(observedAt) - Date.parse(priorDownSince))
        : 0,
      recordPath,
    };
    appendRecord(recordPath, result);
    return result;
  }

  const target = `gui/${String(dependencies.uid())}/${DAEMON_LABEL}`;
  let status: WatchdogStatus;
  try {
    const service = await dependencies.launchctl(["print", target]);
    status =
      service.exitCode === 0
        ? "service_present_unhealthy"
        : isAbsentService(service)
          ? "service_absent"
          : "launchctl_unknown";
  } catch {
    status = "launchctl_unknown";
  }

  let action: WatchdogAction = "none";
  let actionExitCode: number | null = null;
  let actionError: string | null = null;
  if (opts.heal) {
    if (status === "service_absent") {
      action = "bootstrap";
      try {
        actionExitCode = (
          await dependencies.launchctl([
            "bootstrap",
            `gui/${String(dependencies.uid())}`,
            dependencies.plistPath,
          ])
        ).exitCode;
      } catch (err) {
        actionError = errorMessage(err);
      }
    } else if (status === "service_present_unhealthy") {
      action = "kickstart";
      try {
        actionExitCode = (await dependencies.launchctl(["kickstart", "-k", target])).exitCode;
      } catch (err) {
        actionError = errorMessage(err);
      }
    }
  }

  const downSince = readActiveDownSince(recordPath) ?? observedAt;
  const result: WatchdogResult = {
    status,
    action,
    actionExitCode,
    actionError,
    observedAt,
    downSince,
    downtimeMs: Math.max(0, Date.parse(observedAt) - Date.parse(downSince)),
    recordPath,
  };
  appendRecord(recordPath, result);
  dependencies.error(
    JSON.stringify({
      level: "error",
      event: "penumbra_watchdog_daemon_down",
      ...result,
    }),
  );
  return result;
}

async function probeDaemonHealth(storageRoot: string): Promise<boolean> {
  const portPath = join(storageRoot, "port");
  if (!existsSync(portPath)) return false;
  const port = Number(readFileSync(portPath, "utf8").trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  const process = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function appendRecord(recordPath: string, result: WatchdogResult): void {
  mkdirSync(dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, `${JSON.stringify(result)}\n`, "utf8");
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the existing watchdog-state parser while grandfathering its pre-existing complexity.
function readActiveDownSince(recordPath: string): string | null {
  if (!existsSync(recordPath)) return null;
  let activeDownSince: string | null = null;
  for (const line of readFileSync(recordPath, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as Partial<WatchdogResult>;
      if (record.status === "healthy") {
        activeDownSince = null;
      } else if (isDownStatus(record.status)) {
        activeDownSince = validIsoDate(record.downSince)
          ? record.downSince
          : validIsoDate(record.observedAt)
            ? record.observedAt
            : null;
      }
    } catch {
      // A partial line from an interrupted append must not prevent the next observation.
    }
  }
  return activeDownSince;
}

function isDownStatus(status: unknown): status is Exclude<WatchdogStatus, "healthy"> {
  return (
    status === "service_absent" ||
    status === "service_present_unhealthy" ||
    status === "launchctl_unknown"
  );
}

function isAbsentService(result: LaunchctlResult): boolean {
  return (
    result.exitCode !== 0 &&
    /could not find service|service not found/i.test(`${result.stdout}\n${result.stderr}`)
  );
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
