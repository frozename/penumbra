import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { DispatchEventLog } from "@src/services/dispatch-event-log.js";
import { ScratchWorktreesService } from "@src/services/scratch-worktrees.js";
import { type WorktreeCommandRunner, WorktreeManager } from "@src/worktree/manager.js";
import {
  readScratchOwner,
  resolveWorktreeGitDir,
  scratchDirName,
  writeScratchOwner,
} from "@src/worktree/scratch.js";

const execFile = promisify(execFileCb);

const realRunner: WorktreeCommandRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, encoding: opts?.encoding ?? "utf8" });

// Records every git argv the manager issues so tests can assert whether a
// `worktree prune` ran on the per-run release path (it must not — prune is
// GC-tick only) and that the sweep still runs one.
function spyGitCalls(calls: string[][]): WorktreeCommandRunner {
  return (cmd, args, opts) => {
    if (cmd === "git") calls.push(args);
    return realRunner(cmd, args, opts);
  };
}

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

// bun:test types `.rejects.toThrow(...)` as void — assert rejections by hand.
async function expectRejectsWith(
  promise: Promise<unknown>,
  matcher: RegExp | string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (matcher instanceof RegExp) {
      expect(message).toMatch(matcher);
    } else {
      expect(message).toContain(matcher);
    }
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

function insertHandoff(
  db: Database,
  handoffId: string,
  workflowRunId: string,
  status: string,
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, use_worktree, chain_task_type, workflow_run_id
     ) VALUES (?, '2026-05-01T00:00:00.000Z', NULL, ?, 'maestro', 'worker',
               NULL, 'do work', ?, 0, 'review_adversarial', ?)`,
    [handoffId, `c-${handoffId}`, status, workflowRunId],
  );
}

describe("ScratchWorktreesService", () => {
  let db: Database;
  let repoDir: string;
  let base: string;
  let sha: string;
  let manager: WorktreeManager;
  let eventLog: DispatchEventLog;
  let storageDir: string;
  const temps: string[] = [];

  beforeEach(async () => {
    db = freshDb();
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-scratch-repo-"));
    temps.push(repoDir);
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", "init"]);
    sha = await git(repoDir, ["rev-parse", "HEAD"]);
    base = `${repoDir}-worktrees`;
    temps.push(base);
    const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-scratch-root-"));
    temps.push(managerRoot);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-scratch-storage-"));
    temps.push(storageDir);
    manager = new WorktreeManager({ rootDir: managerRoot, mainRepoDir: repoDir });
    eventLog = new DispatchEventLog(db);
  });

  afterEach(() => {
    for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
    db.close();
  });

  function makeService(
    overrides: Partial<ConstructorParameters<typeof ScratchWorktreesService>[0]> = {},
  ): ScratchWorktreesService {
    return new ScratchWorktreesService({
      db,
      worktreeManager: manager,
      dispatchEventLog: eventLog,
      mainRepoDir: repoDir,
      storageRoot: storageDir,
      ...overrides,
    });
  }

  test("acquire creates a detached scratch worktree bound to the run id", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-1", cwd: repoDir });

    expect(handle.owner_run_id).toBe("run-1");
    expect(handle.sha).toBe(sha);
    expect(handle.repo_root).toBe(fs.realpathSync(repoDir));
    expect(handle.path).toBe(fs.realpathSync(path.join(base, scratchDirName("run-1"))));
    expect(fs.existsSync(handle.path)).toBe(true);
    const owner = readScratchOwner(handle.path);
    expect(owner?.owner_run_id).toBe("run-1");
    expect(svc.isLive("run-1")).toBe(true);

    await handle.release();
  });

  test("acquire returns the live handle for a repeated run id (idempotent)", async () => {
    const svc = makeService();
    const first = await svc.acquire({ owner_run_id: "run-1", cwd: repoDir });
    const second = await svc.acquire({ owner_run_id: "run-1", cwd: repoDir });
    expect(second.path).toBe(first.path);
    await first.release();
  });

  test("acquire rejects invalid owner_run_id and unresolvable refs", async () => {
    const svc = makeService();
    await expectRejectsWith(
      svc.acquire({ owner_run_id: "a/b", cwd: repoDir }),
      "scratch_invalid_owner_run_id",
    );
    await expectRejectsWith(
      svc.acquire({ owner_run_id: "run-x", cwd: repoDir, ref: "-all" }),
      "scratch_ref_looks_like_flag",
    );
    await expectRejectsWith(
      svc.acquire({ owner_run_id: "run-x", cwd: repoDir, ref: "nonexistent-ref" }),
      "scratch_ref_unresolvable",
    );
    await expectRejectsWith(
      svc.acquire({ owner_run_id: "run-x", cwd: path.join(repoDir, "not-a-repo") }),
      "scratch_cwd_not_git",
    );
  });

  test("release removes the worktree and clears liveness", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-1", cwd: repoDir });
    const result = await handle.release();
    expect(result).toEqual({ kept: false });
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(svc.isLive("run-1")).toBe(false);
    // Releasing twice is a no-op.
    const again = await svc.release("run-1");
    expect(again).toEqual({ kept: false });
  });

  test("release waits briefly for live dispatches, then keeps with the marker", async () => {
    let nowMs = Date.now();
    const svc = makeService({
      now: () => nowMs,
      sleep: (ms) => {
        nowMs += ms;
        return Promise.resolve();
      },
      releaseWaitMs: 1_000,
    });
    const handle = await svc.acquire({ owner_run_id: "run-live", cwd: repoDir });
    insertHandoff(db, "h-disp", "run-live", "dispatched");

    const result = await handle.release();
    expect(result).toEqual({ kept: true, keep_reason: "live_dispatches_at_release" });
    // The dir survives and carries the keep reason.
    expect(fs.existsSync(handle.path)).toBe(true);
    const owner = readScratchOwner(handle.path);
    expect(owner?.keep_reason).toBe("live_dispatches_at_release");
  });

  test("sweepOrphans defers a scratch while its release is still waiting on live dispatches", async () => {
    // release() must keep the run protected until it decides — deleting the
    // live entry up front lets a GC tick reap a scratch whose personas are
    // still dispatched. The marker records a dead pid so the ownership
    // rules alone cannot save the dir: only the live set does.
    let nowMs = Date.now();
    const svc = makeService({
      now: () => nowMs,
      sleep: (ms) => {
        nowMs += ms;
        return Promise.resolve();
      },
      releaseWaitMs: 10_000,
      daemonIdentity: { daemon_id: "daemon-rel", pid: 4_000_001, boot_id: "boot-rel" },
      pidAlive: (pid) => pid === process.pid,
    });
    const handle = await svc.acquire({ owner_run_id: "run-rel", cwd: repoDir });
    insertHandoff(db, "h-rel", "run-rel", "dispatched");

    const releaseP = handle.release();
    await Promise.resolve();
    const sweep = await svc.sweepOrphans();
    expect(sweep.reaped).toEqual([]);
    expect(sweep.deferred).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(true);

    // The wait expires with the handoff still dispatched → kept.
    const result = await releaseP;
    expect(result).toEqual({ kept: true, keep_reason: "live_dispatches_at_release" });
  });

  test("release proceeds immediately when the run's handoffs are terminal", async () => {
    const svc = makeService({ releaseWaitMs: 1_000 });
    const handle = await svc.acquire({ owner_run_id: "run-done", cwd: repoDir });
    insertHandoff(db, "h-done", "run-done", "completed");
    const result = await handle.release();
    expect(result).toEqual({ kept: false });
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test("release with an explicit keep_reason retains the worktree", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-keep", cwd: repoDir });
    const result = await handle.release({ keep_reason: "operator_kept" });
    expect(result).toEqual({ kept: true, keep_reason: "operator_kept" });
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(readScratchOwner(handle.path)?.keep_reason).toBe("operator_kept");
  });

  test("release does not run git worktree prune — prune is a GC-tick operation", async () => {
    const calls: string[][] = [];
    const spyManager = new WorktreeManager({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-spy-root-")),
      mainRepoDir: repoDir,
      runner: spyGitCalls(calls),
    });
    const svc = makeService({ worktreeManager: spyManager });
    const handle = await svc.acquire({ owner_run_id: "run-noprune", cwd: repoDir });

    calls.length = 0;
    const result = await handle.release();
    expect(result).toEqual({ kept: false });
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(calls.some((args) => args[0] === "worktree" && args[1] === "prune")).toBe(false);
  });

  test("sweepOrphans still prunes stale worktree admin entries (GC tick)", async () => {
    const calls: string[][] = [];
    const spyManager = new WorktreeManager({
      rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-spy-root-")),
      mainRepoDir: repoDir,
      runner: spyGitCalls(calls),
    });
    const svc = makeService({ worktreeManager: spyManager });
    await svc.acquire({ owner_run_id: "run-crash", cwd: repoDir });

    calls.length = 0;
    const restarted = makeService({ worktreeManager: spyManager });
    await restarted.sweepOrphans();
    expect(calls.some((args) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
  });

  test("sweepOrphans defers live scratch worktrees", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-live", cwd: repoDir });
    const result = await svc.sweepOrphans();
    expect(result.deferred).toContain(handle.path);
    expect(result.reaped).toEqual([]);
    await handle.release();
  });

  test("sweepOrphans reaps an abandoned dir whose run released without cleanup (crash)", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-crash", cwd: repoDir });
    // Simulate a daemon restart: a new service has no live set, so the dir
    // with a valid owner marker but no keep_reason reads as abandoned.
    const restarted = makeService();
    const result = await restarted.sweepOrphans();
    expect(result.reaped).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(false);
    // Original live set is stale but the dir is gone — release is a no-op-ish.
    await handle.release();
  });

  test("sweepOrphans keeps a keep_reason dir inside its TTL and reaps it after expiry", async () => {
    let nowMs = Date.now();
    const svc = makeService({ now: () => nowMs });
    const handle = await svc.acquire({ owner_run_id: "run-keep", cwd: repoDir });
    await handle.release({ keep_reason: "operator_kept" });

    const restarted = makeService({ now: () => nowMs, keepTtlMs: 60_000 });
    let result = await restarted.sweepOrphans();
    expect(result.kept).toContain(handle.path);
    expect(result.reaped).toEqual([]);

    nowMs += 120_000;
    result = await restarted.sweepOrphans();
    expect(result.reaped).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test("sweepOrphans defers a torn dir inside partial-create grace, reaps it after", async () => {
    const torn = path.join(base, scratchDirName("run-torn"));
    fs.mkdirSync(torn, { recursive: true });
    fs.writeFileSync(path.join(torn, ".git"), "gitdir: /nonexistent\n");

    const nowMs = Date.now();
    const svc = makeService({ now: () => nowMs, partialCreateGraceMs: 60_000 });
    let result = await svc.sweepOrphans();
    expect(result.deferred.map((p) => path.basename(p))).toContain(path.basename(torn));
    expect(result.reaped).toEqual([]);

    // Age the dir past the grace window by rewriting mtime backwards.
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(torn, past, past);
    result = await svc.sweepOrphans();
    expect(result.reaped.map((p) => path.basename(p))).toContain(path.basename(torn));
    expect(fs.existsSync(torn)).toBe(false);
  });

  test("sweepOrphans emits a worktree.gc event with scratch meta for each reap", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-ev", cwd: repoDir });
    const restarted = makeService();
    await restarted.sweepOrphans();

    const rows = db
      .query<
        { kind: string; meta_json: string },
        []
      >(`SELECT kind, meta_json FROM dispatch_events WHERE kind = 'worktree.gc'`)
      .all();
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]!.meta_json) as Record<string, unknown>;
    expect(meta.scratch).toBe(true);
    expect(meta.path).toBe(handle.path);
    expect(meta.reason).toBe("abandoned");
  });

  test("validateCwdOverride accepts the service's own scratch and rejects foreign paths", async () => {
    const svc = makeService();
    const handle = await svc.acquire({ owner_run_id: "run-v", cwd: repoDir });
    const ok = svc.validateCwdOverride({
      cwd_override: handle.path,
      owner_run_id: "run-v",
      project_id: null,
    });
    expect(ok.ok).toBe(true);

    const foreign = svc.validateCwdOverride({
      cwd_override: repoDir,
      owner_run_id: "run-v",
      project_id: null,
    });
    expect(foreign.ok).toBe(false);

    await handle.release();
  });

  test("a sweep from a service with a different daemon identity leaves a fresh foreign-owned scratch alone", async () => {
    // A second daemon (or a test harness on another storage root) that can
    // see the same fleet base must never reap this daemon's live scratch —
    // the HIGH defect reproduced: an unrelated sweep deleted it outright.
    const foreignStorage = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-foreign-"));
    temps.push(foreignStorage);
    const foreign = makeService({ storageRoot: foreignStorage });
    const handle = await foreign.acquire({ owner_run_id: "run-foreign", cwd: repoDir });

    const local = makeService();
    const result = await local.sweepOrphans();
    expect(result.reaped).toEqual([]);
    expect(result.deferred).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(true);
    await handle.release();
  });

  test("a scratch from this daemon's previous incarnation is reaped (old boot id)", async () => {
    const first = makeService({
      daemonIdentity: { daemon_id: "daemon-x", pid: process.pid, boot_id: "boot-old" },
    });
    const handle = await first.acquire({ owner_run_id: "run-prev", cwd: repoDir });
    // Same daemon id, new boot id — this service instance is the restart.
    const restarted = makeService({
      daemonIdentity: { daemon_id: "daemon-x", pid: process.pid, boot_id: "boot-new" },
    });
    const result = await restarted.sweepOrphans();
    expect(result.reaped).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test("a scratch from this daemon recorded under a dead pid is reaped", async () => {
    const first = makeService({
      daemonIdentity: { daemon_id: "daemon-x", pid: 4_000_000, boot_id: "boot-dead" },
      pidAlive: (pid) => pid === process.pid,
    });
    const handle = await first.acquire({ owner_run_id: "run-dead", cwd: repoDir });
    const restarted = makeService({
      daemonIdentity: { daemon_id: "daemon-x", pid: process.pid, boot_id: "boot-new" },
      pidAlive: (pid) => pid === process.pid,
    });
    const result = await restarted.sweepOrphans();
    expect(result.reaped).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test("a foreign scratch past the grace period is reaped as a last resort", async () => {
    const foreignStorage = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-svc-foreign-"));
    temps.push(foreignStorage);
    const foreign = makeService({ storageRoot: foreignStorage });
    const handle = await foreign.acquire({ owner_run_id: "run-foreign-old", cwd: repoDir });
    // Age the marker back beyond the foreign grace window.
    const owner = readScratchOwner(handle.path);
    writeScratchOwner(handle.path, {
      ...owner!,
      created_at: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
    });

    const local = makeService();
    const result = await local.sweepOrphans();
    expect(result.reaped).toContain(handle.path);
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test("a legacy owner record without daemon identity is foreign until past the grace period", async () => {
    const wtPath = path.join(base, scratchDirName("run-legacy"));
    await git(repoDir, ["worktree", "add", "--detach", wtPath, sha]);
    const gitDir = resolveWorktreeGitDir(wtPath);
    if (gitDir === null) throw new Error("expected a resolved worktree gitdir");
    fs.writeFileSync(
      path.join(gitDir, "penumbra-scratch.json"),
      `${JSON.stringify({ owner_run_id: "run-legacy", sha, created_at: new Date().toISOString() })}\n`,
    );

    const wtReal = fs.realpathSync(wtPath);
    const svc = makeService();
    let result = await svc.sweepOrphans();
    expect(result.reaped).toEqual([]);
    expect(result.deferred).toContain(wtReal);
    expect(fs.existsSync(wtPath)).toBe(true);

    // Age the marker past the grace window: the last-resort reap applies.
    fs.writeFileSync(
      path.join(gitDir, "penumbra-scratch.json"),
      `${JSON.stringify({ owner_run_id: "run-legacy", sha, created_at: new Date(Date.now() - 7 * 60 * 60_000).toISOString() })}\n`,
    );
    result = await svc.sweepOrphans();
    expect(result.reaped).toContain(wtReal);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  test("sweeps stay confined to configured roots — an unconfigured fleet base is never scanned", async () => {
    // The WorktreeManager knows repoDir (mainRepoDir), but the service is
    // given no configured roots — so a sweep must scan nothing rather than
    // reach into whatever root the manager fell back to.
    const created = await manager.createScratchWorktree({
      owner_run_id: "run-out-of-scope",
      repoRoot: repoDir,
      sha,
    });

    const svc = makeService({ mainRepoDir: undefined });
    const result = await svc.sweepOrphans();
    expect(result.reaped).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(fs.existsSync(created.path)).toBe(true);
    fs.rmSync(created.path, { recursive: true, force: true });
  });
});
