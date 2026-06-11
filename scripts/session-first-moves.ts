import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 10000 }).trim();
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

async function daemonGet(baseUrl: string, token: string, path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function resolveProjectId(): string | null {
  const remoteUrl = run("git config --get remote.origin.url");
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/[:/]([^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function main() {
  const gitStatusDirtyCount = parseInt(run("git status --porcelain | wc -l"), 10) || 0;
  const headSha = run("git rev-parse HEAD") || null;
  const originMainSha = run("git rev-parse origin/main") || null;

  let daemonPid: number | null = null;
  try {
    const lcOut = execSync("launchctl list", { encoding: "utf8", timeout: 5000 });
    const line = lcOut.split("\n").find((l) => l.includes("dev.penumbra.daemon"));
    if (line) {
      const pidStr = line.trim().split(/\s+/)[0];
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid > 0) daemonPid = pid;
    }
  } catch {}

  const storageRoot = resolveStorageRoot();
  let daemonHealthy = false;
  let workerCount: number | null = null;
  let pendingHandoffs: number | null = null;
  let pendingTaskDrafts: number | null = null;
  let openLanes: number | null = null;

  let baseUrl = "";
  let token = "";

  if (storageRoot) {
    try {
      const port = readFileSync(join(storageRoot, "port"), "utf8").trim();
      token = readFileSync(join(storageRoot, "token"), "utf8").trim();
      baseUrl = `http://127.0.0.1:${port}`;

      const health = await daemonGet(baseUrl, token, "/health");
      daemonHealthy = health != null && (health as Record<string, unknown>)?.status === "ok";

      const handoffsData = await daemonGet(baseUrl, token, "/handoffs");
      if (handoffsData && typeof handoffsData === "object" && "handoffs" in handoffsData) {
        pendingHandoffs = Array.isArray((handoffsData as Record<string, unknown>).handoffs)
          ? ((handoffsData as Record<string, unknown>).handoffs as unknown[]).length
          : null;
      }

      const projectId = resolveProjectId();
      if (projectId) {
        const draftsData = await daemonGet(
          baseUrl,
          token,
          `/task-drafts/pending?latest_event_type=task_draft&project_id=${encodeURIComponent(projectId)}`,
        );
        if (draftsData && typeof draftsData === "object" && "drafts" in draftsData) {
          pendingTaskDrafts = Array.isArray((draftsData as Record<string, unknown>).drafts)
            ? ((draftsData as Record<string, unknown>).drafts as unknown[]).length
            : null;
        }
      }

      const lanesData = await daemonGet(baseUrl, token, "/lanes/recent?status=open&limit=200");
      if (lanesData && typeof lanesData === "object" && "lanes" in lanesData) {
        openLanes = Array.isArray((lanesData as Record<string, unknown>).lanes)
          ? ((lanesData as Record<string, unknown>).lanes as unknown[]).length
          : null;
      }
    } catch {}
  }

  let gateDeltas: { filtered: number | null; neardup: number | null } = {
    filtered: null,
    neardup: null,
  };
  if (storageRoot) {
    const dbPath = join(storageRoot, "db.sqlite");
    if (existsSync(dbPath)) {
      let db: Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const filteredRow = db
          .query<
            { c: number },
            []
          >("SELECT COUNT(*) AS c FROM t1_rollups WHERE promotion_filtered_at IS NOT NULL")
          .get();
        gateDeltas.filtered = filteredRow?.c ?? null;

        const neardupRow = db
          .query<
            { c: number },
            []
          >("SELECT COUNT(*) AS c FROM dream_actions WHERE source = 't2_promotion_near_dup_gate' AND status IN ('queued', 'approved', 'auto_applied')")
          .get();
        gateDeltas.neardup = neardupRow?.c ?? null;
      } catch {
        // degrade gracefully
      } finally {
        db?.close();
      }
    }
  }

  const result = {
    git_status_dirty_count: gitStatusDirtyCount,
    head_sha: headSha,
    origin_main_sha: originMainSha,
    daemon_pid: daemonPid,
    daemon_healthy: daemonHealthy,
    worker_count: workerCount,
    pending_handoffs: pendingHandoffs,
    pending_task_drafts: pendingTaskDrafts,
    gate_deltas: gateDeltas,
    open_lanes: openLanes,
  };

  console.log(JSON.stringify(result));
}

main();
