import { collectSessionFirstMoves } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function resolveStorageRoot(): string | null {
  const env = process.env.PENUMBRA_STORAGE_ROOT;
  if (env && existsSync(join(env, "port")) && existsSync(join(env, "token"))) {
    return env;
  }
  const candidates = [join(homedir(), ".penumbra"), "/tmp/penumbra-live"];
  for (const c of candidates) {
    if (existsSync(join(c, "port")) && existsSync(join(c, "token"))) {
      return c;
    }
  }
  return null;
}

async function daemonGet(baseUrl: string, token: string, path: string): Promise<unknown> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

function resolveProjectId(): string | null {
  const remoteUrl = run("git config --get remote.origin.url");
  if (!remoteUrl) {
    return null;
  }
  const match = /[:/]([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  return match?.[1] ?? null;
}

function getArrayLen(data: unknown, key: string): number | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const obj = data as Record<string, unknown>;
  const value = obj[key];
  return Array.isArray(value) ? value.length : null;
}

function readDaemonPid(): number | null {
  try {
    const lcOut = execSync("launchctl list", { encoding: "utf8", timeout: 5000 });
    const line = lcOut.split("\n").find((l) => l.includes("dev.penumbra.daemon"));
    if (!line) {
      return null;
    }
    const pidStr = line.trim().split(/\s+/)[0];
    if (!pidStr) {
      return null;
    }
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

type DaemonSnapshot = {
  daemonHealthy: boolean;
  pendingHandoffs: number | null;
  pendingTaskDrafts: number | null;
  openLanes: number | null;
};

async function readDaemonState(baseUrl: string, token: string): Promise<DaemonSnapshot> {
  const health = await daemonGet(baseUrl, token, "/health");
  const daemonHealthy =
    !!health && typeof health === "object" && (health as Record<string, unknown>).status === "ok";

  const handoffsData = await daemonGet(baseUrl, token, "/handoffs");
  const pendingHandoffs = getArrayLen(handoffsData, "handoffs");

  let pendingTaskDrafts: number | null = null;
  const projectId = resolveProjectId();
  if (projectId) {
    const draftsData = await daemonGet(
      baseUrl,
      token,
      `/task-drafts/pending?latest_event_type=task_draft&project_id=${encodeURIComponent(projectId)}`,
    );
    pendingTaskDrafts = getArrayLen(draftsData, "drafts");
  }

  const lanesData = await daemonGet(baseUrl, token, "/lanes/recent?status=open&limit=200");
  const openLanes = getArrayLen(lanesData, "lanes");

  return { daemonHealthy, pendingHandoffs, pendingTaskDrafts, openLanes };
}

async function main(): Promise<void> {
  const gitStatusDirtyCount = parseInt(run("git status --porcelain | wc -l"), 10) || 0;
  const headSha = run("git rev-parse HEAD") || null;
  const originMainSha = run("git rev-parse origin/main") || null;
  const daemonPid = readDaemonPid();
  const storageRoot = resolveStorageRoot();

  let daemonState: DaemonSnapshot = {
    daemonHealthy: false,
    pendingHandoffs: null,
    pendingTaskDrafts: null,
    openLanes: null,
  };
  if (storageRoot) {
    try {
      const port = readFileSync(join(storageRoot, "port"), "utf8").trim();
      const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
      const baseUrl = `http://127.0.0.1:${port}`;
      daemonState = await readDaemonState(baseUrl, token);
    } catch {
      // unreachable daemon; keep defaults
    }
  }

  let db: Database | null = null;
  let fallbackDb: Database | null = null;
  try {
    if (storageRoot && existsSync(join(storageRoot, "db.sqlite"))) {
      db = new Database(join(storageRoot, "db.sqlite"), { readonly: true });
    }
    fallbackDb = db ? null : new Database(":memory:");
    const activeDb = db ?? fallbackDb;
    if (!activeDb) {
      throw new Error("session-first-moves db unavailable");
    }
    const result = collectSessionFirstMoves({
      db: activeDb,
      git_status_dirty_count: gitStatusDirtyCount,
      head_sha: headSha,
      origin_main_sha: originMainSha,
      daemon_pid: daemonPid,
      daemon_healthy: daemonState.daemonHealthy,
      worker_count: null,
      worker_pids: [],
      pending_handoffs: daemonState.pendingHandoffs,
      pending_task_drafts: daemonState.pendingTaskDrafts,
      project_id: resolveProjectId(),
      open_lanes: daemonState.openLanes,
    });
    const scriptResult: Partial<typeof result> = { ...result };
    delete scriptResult.worker_pids;
    process.stdout.write(JSON.stringify(scriptResult) + "\n");
  } finally {
    db?.close();
    fallbackDb?.close();
  }
}

await main();
