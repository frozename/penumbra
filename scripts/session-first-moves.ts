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

type GateDeltas = { filtered: number | null; neardup: number | null };

function readGateDeltas(storageRoot: string): GateDeltas {
  const deltas: GateDeltas = { filtered: null, neardup: null };
  const dbPath = join(storageRoot, "db.sqlite");
  if (!existsSync(dbPath)) {
    return deltas;
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const filteredRow = db
      .query<
        { c: number },
        []
      >("SELECT COUNT(*) AS c FROM t1_rollups WHERE promotion_filtered_at IS NOT NULL")
      .get();
    deltas.filtered = filteredRow?.c ?? null;

    const neardupRow = db
      .query<
        { c: number },
        []
      >("SELECT COUNT(*) AS c FROM dream_actions WHERE json_extract(payload_json,'$.source') = 't2_promotion_near_dup_gate' AND status IN ('queued', 'approved', 'auto_applied')")
      .get();
    deltas.neardup = neardupRow?.c ?? null;
  } catch {
    // degrade gracefully
  } finally {
    db?.close();
  }
  return deltas;
}

type PinShare = {
  role_24h: number;
  pinned_24h: number;
  role_7d: number;
  pinned_7d: number;
  steerable_role_7d: number;
  steerable_pinned_7d: number;
};
function readPinShare(storageRoot: string): PinShare | null {
  const dbPath = join(storageRoot, "db.sqlite");
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return (
      db
        .query<
          PinShare,
          []
        >(`SELECT SUM(CASE WHEN ts >= datetime('now','-1 day') AND routing_resolution_reason='role_route' THEN 1 ELSE 0 END) AS role_24h, SUM(CASE WHEN ts >= datetime('now','-1 day') AND routing_resolution_reason IS NULL THEN 1 ELSE 0 END) AS pinned_24h, SUM(CASE WHEN routing_resolution_reason='role_route' THEN 1 ELSE 0 END) AS role_7d, SUM(CASE WHEN routing_resolution_reason IS NULL THEN 1 ELSE 0 END) AS pinned_7d, SUM(CASE WHEN COALESCE(dispatch_kind,'mcp') IN ('mcp','workflow') AND routing_resolution_reason='role_route' THEN 1 ELSE 0 END) AS steerable_role_7d, SUM(CASE WHEN COALESCE(dispatch_kind,'mcp') IN ('mcp','workflow') AND routing_resolution_reason IS NULL THEN 1 ELSE 0 END) AS steerable_pinned_7d FROM handoffs WHERE ts >= datetime('now','-7 days')`)
        .get() ?? null
    );
  } catch {
    return null;
  } finally {
    db?.close();
  }
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

  const gateDeltas: GateDeltas = storageRoot
    ? readGateDeltas(storageRoot)
    : { filtered: null, neardup: null };
  const pinShare = storageRoot ? readPinShare(storageRoot) : null;

  const result = {
    git_status_dirty_count: gitStatusDirtyCount,
    head_sha: headSha,
    origin_main_sha: originMainSha,
    daemon_pid: daemonPid,
    daemon_healthy: daemonState.daemonHealthy,
    worker_count: null,
    pending_handoffs: daemonState.pendingHandoffs,
    pending_task_drafts: daemonState.pendingTaskDrafts,
    gate_deltas: gateDeltas,
    pin_share: pinShare,
    open_lanes: daemonState.openLanes,
  };

  process.stdout.write(JSON.stringify(result) + "\n");
}

await main();
