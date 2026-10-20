import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSessionFirstMovesSource } from "@src/recall-sources/session-first-moves.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function seedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-first-moves-repo-"));
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email t@t", { cwd: repo });
  execSync("git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  execSync('git add tracked.txt && git commit -q -m "init"', { cwd: repo, shell: "/bin/bash" });
  return repo;
}

test("returns git_status_dirty_count, head_sha, daemon/worker pids, gate_deltas, pin_share", async () => {
  const db = freshDb();
  const repo = seedRepo();
  try {
    writeFileSync(join(repo, "dirty.txt"), "dirty\n");
    db.run(`
      INSERT INTO t1_rollups (
        rollup_id, project_id, user_id, session_id, started_at, n_events, source_event_ids, promotion_filtered_at
      )
      VALUES ('r1', 'penumbra', 'u1', 's1', '2026-05-01', 1, '[]', '2026-05-01')
    `);
    db.run(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, routing_resolution_reason, dispatch_kind)
      VALUES ('h-role', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'), 'c1', 'maestro', 'worker', 'role routed', 'pending', 'role_route', 'workflow')
    `);

    const out = await runSessionFirstMovesSource({
      db,
      cwd: repo,
      args: {},
      readDaemonPid: () => 321,
      readWorkerPids: () => [654, 987],
    });

    expect(out.result.git_status_dirty_count).toBe(1);
    expect(out.result.daemon_pid).toBe(321);
    expect(out.result.daemon_healthy).toBe(true);
    expect(out.result.worker_count).toBe(2);
    expect(out.result.worker_pids).toEqual([654, 987]);
    expect(out.result.pending_handoffs).toBe(1);
    expect(out.result.gate_deltas).toEqual({ filtered: 1, neardup: 0 });
    expect(out.result.pin_share?.role_24h).toBe(1);
    expect(out.result.pin_share?.steerable_role_7d).toBe(1);
    expect(typeof out.result.head_sha).toBe("string");
    expect(out.result.head_sha).toHaveLength(40);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("filters pending task drafts to the workflow project", async () => {
  const db = freshDb();
  const repo = seedRepo();
  try {
    db.run(`
      INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, session_id, event_type, lane, payload_json)
      VALUES
        ('e-penumbra', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'test', 'penumbra', 'u1', 'm1', 's1', 'task_draft', 'system', '{"draft_id":"d-penumbra"}'),
        ('e-sibling', '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', 'test', 'sibling', 'u1', 'm1', 's1', 'task_draft', 'system', '{"draft_id":"d-sibling"}')
    `);

    const out = await runSessionFirstMovesSource({
      db,
      cwd: repo,
      project: "penumbra",
      args: {},
      readDaemonPid: () => null,
      readWorkerPids: () => [],
    });

    expect(out.result.pending_task_drafts).toBe(1);
  } finally {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("default launchctl reader spawns once and derives daemon plus worker pids from the same output", async () => {
  const db = freshDb();
  const repo = seedRepo();
  const originalSpawnSync = Bun.spawnSync;
  const launchctlOutput =
    "111\t0\tdev.penumbra.daemon\n222\t0\tdev.penumbra.worker\n333\t0\tdev.penumbra.agentchat-worker\n";
  const spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((options) => {
    const cmd = Array.isArray(options) ? options : options.cmd;
    if (Array.isArray(cmd) && cmd[0] === "launchctl") {
      return originalSpawnSync({
        cmd: ["printf", launchctlOutput],
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    return originalSpawnSync(options);
  });
  try {
    const out = await runSessionFirstMovesSource({
      db,
      cwd: repo,
      project: "penumbra",
      args: {},
    });

    expect(out.result.daemon_pid).toBe(111);
    expect(out.result.worker_pids).toEqual([222, 333]);
    expect(out.result.worker_count).toBe(2);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  } finally {
    spawnSpy.mockRestore();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("collects open PRs through the injected gh runner and marks foreign authors and heads no handoff produced", async () => {
  const db = freshDb();
  const repo = seedRepo();
  try {
    db.run(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, branch_name)
      VALUES ('h-lane', '2026-09-21T09:00:00.000Z', 'c1', 'maestro', 'worker', 'lane', 'completed', 'fix/issue-71_abcd1234')
    `);
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];

    const out = await runSessionFirstMovesSource({
      db,
      cwd: repo,
      args: {},
      readDaemonPid: () => null,
      readWorkerPids: () => [],
      runGh: (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts.cwd });
        if (args[0] === "api") return Promise.resolve({ stdout: "frozename\n", stderr: "" });
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              number: 74,
              title: "Implement #71",
              headRefName: "feat/other-account",
              author: { login: "second-account" },
              createdAt: "2026-09-21T10:00:00Z",
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            },
            {
              number: 78,
              title: "Fix #71",
              headRefName: "fix/issue-71_abcd1234",
              author: { login: "frozename" },
              createdAt: "2026-09-21T11:00:00Z",
              statusCheckRollup: [],
            },
          ]),
          stderr: "",
        });
      },
    });

    expect(calls.map((call) => [call.cmd, ...call.args.slice(0, 2), call.cwd])).toEqual([
      ["gh", "pr", "list", repo],
      ["gh", "api", "user", repo],
    ]);
    expect(out.result.open_prs).toEqual({
      reason: null,
      prs: [
        {
          number: 74,
          title: "Implement #71",
          head_ref: "feat/other-account",
          author: "second-account",
          created_at: "2026-09-21T10:00:00Z",
          checks: "success",
          foreign_author: true,
          not_from_known_lane: true,
        },
        {
          number: 78,
          title: "Fix #71",
          head_ref: "fix/issue-71_abcd1234",
          author: "frozename",
          created_at: "2026-09-21T11:00:00Z",
          checks: "none",
          foreign_author: false,
          not_from_known_lane: false,
        },
      ],
    });
  } finally {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reports open PRs as unavailable instead of failing when gh is missing", async () => {
  const db = freshDb();
  const repo = seedRepo();
  try {
    const out = await runSessionFirstMovesSource({
      db,
      cwd: repo,
      args: {},
      readDaemonPid: () => null,
      readWorkerPids: () => [],
      runGh: () => Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })),
    });

    expect(out.result.open_prs).toEqual({ prs: null, reason: "gh not installed" });
    expect(out.result.head_sha).toHaveLength(40);
  } finally {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
