import type { Database } from "bun:sqlite";

import {
  collectOpenPrs,
  collectSessionFirstMoves,
  type OpenPrsRunner,
  type SessionFirstMoves,
} from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type SessionFirstMovesSourceInput = {
  db: Database;
  cwd: string;
  project?: string;
  args: Record<string, unknown>;
  readDaemonPid?: () => number | null;
  readWorkerPids?: () => number[];
  runGh?: OpenPrsRunner;
};

export type SessionFirstMovesSourceOutput = {
  result: SessionFirstMoves;
  warnings: string[];
};

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["-C", cwd, ...args], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitDirtyCount(cwd: string): Promise<number | null> {
  const status = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  if (status === null) return null;
  if (status.length === 0) return 0;
  return status.split("\0").filter((entry) => entry.length > 0).length;
}

function parsePositivePid(value: string): number | null {
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseLaunchctlPids(output: string, needle: string): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes(needle)) continue;
    const pid = parsePositivePid(line.trim().split(/\s+/)[0] ?? "");
    if (pid !== null) pids.push(pid);
  }
  return pids;
}

function launchctlOutput(): string {
  try {
    return Bun.spawnSync({ cmd: ["launchctl", "list"], stdout: "pipe", stderr: "ignore" })
      .stdout.toString()
      .trim();
  } catch {
    return "";
  }
}

function readDaemonPidFromLaunchctl(output: string): number | null {
  return parseLaunchctlPids(output, "dev.penumbra.daemon")[0] ?? null;
}

function readWorkerPidsFromLaunchctl(output: string): number[] {
  return [
    ...parseLaunchctlPids(output, "dev.penumbra.worker"),
    ...parseLaunchctlPids(output, "dev.penumbra.agentchat-worker"),
  ];
}

export async function runSessionFirstMovesSource(
  input: SessionFirstMovesSourceInput,
): Promise<SessionFirstMovesSourceOutput> {
  const launchctl = input.readDaemonPid && input.readWorkerPids ? "" : launchctlOutput();
  const daemonPid = input.readDaemonPid
    ? input.readDaemonPid()
    : readDaemonPidFromLaunchctl(launchctl);
  const workerPids = input.readWorkerPids
    ? input.readWorkerPids()
    : readWorkerPidsFromLaunchctl(launchctl);
  const result = collectSessionFirstMoves({
    db: input.db,
    git_status_dirty_count: await gitDirtyCount(input.cwd),
    head_sha: await git(input.cwd, ["rev-parse", "HEAD"]),
    origin_main_sha: await git(input.cwd, ["rev-parse", "origin/main"]),
    daemon_pid: daemonPid,
    daemon_healthy: daemonPid !== null,
    worker_pids: workerPids,
    project_id: input.project,
    open_prs: await collectOpenPrs({ cwd: input.cwd, run: input.runGh }),
  });
  return { result, warnings: [] };
}
