import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildServices,
  closeLane,
  insertLane,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { dispatchLandRoute, dispatchLandTaskRoute } from "../../src/routes/dispatch-land.js";
import { createDaemonFetchHandler } from "../../src/serve.js";

function services(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-land-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-08T00:00:00.000Z"),
    uuid: () => `id-${++n}`,
  });
}

function seedHandoff(
  svc: Services,
  handoffId: string,
  conversationId: string,
  projectId: string | null = null,
): void {
  svc.handoffWriter.createApproved({
    handoff_id: handoffId,
    ts: "2026-05-08T00:00:00.000Z",
    project_id: projectId,
    conversation_id: conversationId,
    from: "user",
    to: "codex",
    to_role: null,
    message: `dispatch ${handoffId}`,
    triggered_by_event_id: `evt-${handoffId}`,
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: "implement_small",
    use_worktree: true,
    parent_handoff_id: null,
    branch_base: null,
    open_pr_on_review: false,
  });
}

function seedClosedLaneWithReviewer(
  svc: Services,
  input: {
    laneId: string;
    implementerHandoff: string;
    reviewerHandoff: string;
  },
): void {
  insertLane(svc.db, {
    lane_id: input.laneId,
    ts_opened: "2026-05-08T00:00:00.000Z",
    task_class: "STANDARD",
    implementer_handoff: input.implementerHandoff,
  });
  closeLane(svc.db, input.laneId, {
    ts_closed: "2026-05-08T00:02:00.000Z",
    gate_status: "passed",
    reviewer_handoff: input.reviewerHandoff,
    override_reason: null,
  });
}

function seedMemory(db: Database, memoryId: string): void {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, compressed_from, created_at, updated_at)
     VALUES (?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    [
      memoryId,
      "2026-05-08T00:00:00.000Z",
      "2026-05-08T00:01:00.000Z",
      memoryId,
      `${memoryId} body`,
      "2026-05-08T00:01:00.000Z",
      "2026-05-08T00:01:00.000Z",
    ],
  );
}

function seedDispatchMemory(db: Database, handoffId: string, memoryId: string): void {
  db.run(
    `INSERT INTO dispatch_events(handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', 'memory_recall_injected', '2026-05-08T00:01:30.000Z', ?)`,
    [handoffId, JSON.stringify({ memory_id: memoryId })],
  );
}

function writeVerdictEvent(
  svc: Services,
  input: {
    eventId: string;
    ts: string;
    handoffId: string;
    conversationId: string;
    typecheck: "pass" | "fail";
    tests: "pass" | "fail";
  },
) {
  svc.t0Writer.write({
    event_id: input.eventId,
    ts: input.ts,
    ingest_ts: input.ts,
    source: "agentchat",
    source_detail: "merge-reconciler",
    project_id: null,
    user_id: "local-user",
    machine_id: "machine-1",
    session_id: input.conversationId,
    event_type: "reconciler.verdict",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      handoff_id: input.handoffId,
      conversation_id: input.conversationId,
      branch: `agent/${input.handoffId}`,
      typecheck: input.typecheck,
      tests: input.tests,
      files_changed: 3,
      lines_added: 30,
      lines_deleted: 10,
      summary: `${input.typecheck}/${input.tests}`,
    },
    payload_summary: `${input.typecheck}/${input.tests}`,
  });
}

function seedAgentPerformanceRow(
  svc: Services,
  input: {
    performanceId: string;
    ts: string;
    handoffId: string;
    conversationId: string;
    projectId: string | null;
    agentName: string;
    taskType:
      | "plan_refine"
      | "implement_small"
      | "implement_substantial"
      | "review_adversarial"
      | "docs_mechanical"
      | "debug_diagnose"
      | "smoke_test"
      | "health_check"
      | "unknown";
    outcome:
      | "pr_opened"
      | "merged"
      | "merged_with_concerns"
      | "no_changes"
      | "typecheck_failed"
      | "test_failed"
      | "pr_creation_failed"
      | "rejected"
      | "failed"
      | "partial"
      | "bypassed";
  },
) {
  svc.db
    .prepare(
      `
    INSERT INTO agent_performance (
      performance_id, ts, handoff_id, conversation_id, project_id, agent_name,
      task_type, outcome, gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score,
      cost_usd, tokens_used, latency_ms, source, notes,
      reliability_status, failure_class, artifact_present, verification_present,
      maestro_takeover_required, empty_response, worktree_changed, reconcile_status,
      environment_failure, trust_score, agent_kind, metadata_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `,
    )
    .run(
      input.performanceId,
      input.ts,
      input.handoffId,
      input.conversationId,
      input.projectId,
      input.agentName,
      input.taskType,
      input.outcome,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "reconciler",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "coding",
      "{}",
    );
}

async function waitForLandTask(svc: Services, taskId: string): Promise<any> {
  for (let i = 0; i < 30; i += 1) {
    const res = await dispatchLandTaskRoute(
      new Request(`http://x/dispatch/land/${taskId}`),
      svc,
      taskId,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    if (body.status === "done" || body.status === "failed") return body;
    await Bun.sleep(5);
  }
  throw new Error(`task ${taskId} did not finish`);
}

describe("dispatchLandRoute", () => {
  test("serve.ts wires authenticated POST /dispatch/land", async () => {
    const svc = services();
    const handler = createDaemonFetchHandler({ services: svc, token: "tok" });
    const res = await handler(
      new Request("http://x/dispatch/land", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          handoff_id: "missing",
          commit_message: "chore: test wire",
        }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("not_found");
  });

  test("omitting commit_message resolves it from branch tip", async () => {
    const svc = services();
    seedHandoff(svc, "h-msg-tip", "c-msg-tip");
    writeVerdictEvent(svc, {
      eventId: "v-msg-tip",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-msg-tip",
      conversationId: "c-msg-tip",
      typecheck: "pass",
      tests: "pass",
    });

    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: true,
      branchDeleted: true,
    });

    const gitCalls: string[] = [];
    let revParseCount = 0;
    const post = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-msg-tip",
          mode: "ff",
          delete_branch: true,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          gitCalls.push(args.join(" "));
          if (args[0] === "log") {
            return {
              code: 0,
              stdout: "feat(core): from branch tip\n\nbody\n",
              stderr: "",
            };
          }
          if (args[0] === "rev-parse" && args[1] === "main") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "before-main\n" : "after-main\n",
              stderr: "",
            };
          }
          if (args[0] === "merge" && args[1] === "--ff-only")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(post.status).toBe(202);
    const accepted = (await post.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      commit_sha: "after-main",
      message_subject: "feat(core): from branch tip",
      branch_deleted: true,
      worktree_torn_down: true,
    });
    expect(gitCalls).toContain("log -1 --format=%B agent/h-msg-tip");
  });

  test("resolves repoDir from handoff project before executing git commands", async () => {
    const svc = services();
    seedHandoff(svc, "h-project", "c-project", "other-project");
    writeVerdictEvent(svc, {
      eventId: "v-project",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-project",
      conversationId: "c-project",
      typecheck: "pass",
      tests: "pass",
    });
    const runGitCwd: Array<string | undefined> = [];
    (svc as any).projectRegistry = {
      get: (projectId: string) =>
        projectId === "other-project" ? { root_path: "/tmp/other-repo-path" } : undefined,
      list: () => [{ project_id: "other-project", root_path: "/tmp/other-repo-path" }],
    };

    const post = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-project",
          commit_message: "feat(core): cross-repo land",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[], opts?: { stdin?: string; cwd?: string }) => {
          runGitCwd.push(opts?.cwd);
          if (args[0] === "rev-parse") {
            return {
              code: 0,
              stdout: args[1] === "main" ? "base-main\n" : "merged-main\n",
              stderr: "",
            };
          }
          if (args[0] === "merge" && args[1] === "--ff-only")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(post.status).toBe(202);
    const accepted = (await post.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      message_subject: "feat(core): cross-repo land",
      branch_deleted: false,
      pr_closed: false,
    });
    expect(runGitCwd).toContain("/tmp/other-repo-path");
    expect(runGitCwd.every((cwd) => cwd === "/tmp/other-repo-path")).toBe(true);
  });

  test("returns 202 with task_id and exposes terminal status via GET /dispatch/land/:task_id", async () => {
    const svc = services();
    seedHandoff(svc, "h-async-1", "c-async-1");
    writeVerdictEvent(svc, {
      eventId: "v-async-1",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-async-1",
      conversationId: "c-async-1",
      typecheck: "pass",
      tests: "pass",
    });

    let revParseCount = 0;
    const post = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-async-1",
          commit_message: "feat(core): async land",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(post.status).toBe(202);
    const accepted = (await post.json()) as any;
    expect(accepted.task_id).toBeDefined();
    expect(accepted.status).toBe("queued");

    const terminal = await waitForLandTask(svc, accepted.task_id);
    expect(terminal.status).toBe("done");
    expect(terminal.result).toMatchObject({
      ok: true,
      commit_sha: "new-main",
      message_subject: "feat(core): async land",
      branch_deleted: false,
      pr_closed: false,
    });
  });

  test("returns commit_sha from post-merge main tip", async () => {
    const svc = services();
    seedHandoff(svc, "h-sha-tip", "c-sha-tip");
    writeVerdictEvent(svc, {
      eventId: "v-sha-tip",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-sha-tip",
      conversationId: "c-sha-tip",
      typecheck: "pass",
      tests: "pass",
    });

    let revParseCount = 0;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-sha-tip",
          commit_message: "feat(core): sha tip lock",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "pre-merge-main\n" : "post-merge-main\n",
              stderr: "",
            };
          }
          if (args[0] === "merge" && args[1] === "--ff-only")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe("post-merge-main");
  });

  test("squash mode lands with curated message, emits event, deletes branch, and closes open PR", async () => {
    const svc = services();
    seedHandoff(svc, "h-1", "c-1");
    writeVerdictEvent(svc, {
      eventId: "v-1",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-1",
      conversationId: "c-1",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: Array<{ args: string[]; stdin?: string }> = [];
    let revParseCount = 0;
    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: true,
      branchDeleted: true,
    });
    const deps = {
      runGit: async (args: string[], opts?: { stdin?: string }) => {
        gitCalls.push({ args, stdin: opts?.stdin });
        if (args[0] === "rev-parse" && args[1] === "main") {
          revParseCount += 1;
          return { code: 0, stdout: revParseCount === 1 ? "old-main\n" : "new-main\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      gh: {
        listOpenPullRequestsByHead: async (head: string) => {
          if (head !== "agent/h-1") throw new Error(`unexpected head ${head}`);
          return [{ number: 77 }];
        },
        closePullRequest: async () => {},
      },
      now: () => new Date("2026-05-08T00:02:00.000Z"),
    };

    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-1",
          commit_message: "feat(core): curated subject\n\nbody details",
          mode: "squash",
          delete_branch: true,
        }),
      }),
      svc,
      deps as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.ok).toBe(true);
    expect(body.result.commit_sha).toBe("new-main");
    expect(body.result.message_subject).toBe("feat(core): curated subject");
    expect(body.result.branch_deleted).toBe(true);
    expect(body.result.pr_closed).toBe(true);

    expect(gitCalls.map((c) => c.args.join(" "))).toEqual([
      "rev-parse main",
      "checkout main",
      "merge --squash agent/h-1",
      "commit -F -",
      "rev-parse main",
    ]);
    expect(gitCalls[3]?.stdin).toBe("feat(core): curated subject\n\nbody details");

    const landed = svc.db
      .query<
        { event_type: string; payload_json: string },
        []
      >(`SELECT event_type, payload_json FROM t0_events WHERE event_type='dispatch.landed' ORDER BY ts DESC LIMIT 1`)
      .get();
    expect(landed?.event_type).toBe("dispatch.landed");
    const payload = JSON.parse(landed?.payload_json ?? "{}");
    expect(payload).toMatchObject({
      handoff_id: "h-1",
      conversation_id: "c-1",
      mode: "squash",
      commit_sha: "new-main",
      branch: "agent/h-1",
      message_subject: "feat(core): curated subject",
    });
  });

  test("restamps agent_performance outcome to merged after a successful land", async () => {
    const svc = services();
    seedHandoff(svc, "h-restamp-1", "c-restamp-1");
    writeVerdictEvent(svc, {
      eventId: "v-restamp-1",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-restamp-1",
      conversationId: "c-restamp-1",
      typecheck: "pass",
      tests: "pass",
    });
    seedAgentPerformanceRow(svc, {
      performanceId: "perf-old",
      ts: "2026-05-08T00:01:30.000Z",
      handoffId: "h-restamp-1",
      conversationId: "c-restamp-1",
      projectId: null,
      agentName: "codex",
      taskType: "implement_small",
      outcome: "no_changes",
    });

    let revParseCount = 0;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-restamp-1",
          commit_message: "feat(core): restamp performance",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.ok).toBe(true);

    const row = svc.db
      .query<
        { outcome: string; source: string },
        [string]
      >(`SELECT outcome, source FROM agent_performance WHERE handoff_id = ?`)
      .get("h-restamp-1");
    expect(row).toMatchObject({
      outcome: "merged",
      source: "reconciler",
    });
  });

  test("post-merge auto-authorizes memory verify with dispatch_land basis", async () => {
    const svc = services();
    seedHandoff(svc, "h-land-authz", "c-land-authz");
    seedHandoff(svc, "h-reviewer-authz", "c-reviewer-authz");
    seedClosedLaneWithReviewer(svc, {
      laneId: "lane-land-authz",
      implementerHandoff: "h-land-authz",
      reviewerHandoff: "h-reviewer-authz",
    });
    writeVerdictEvent(svc, {
      eventId: "v-land-authz",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-land-authz",
      conversationId: "c-land-authz",
      typecheck: "pass",
      tests: "pass",
    });
    seedMemory(svc.db, "m-land-authz");
    seedDispatchMemory(svc.db, "h-land-authz", "m-land-authz");

    const realCommit = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(realCommit).toMatch(/^[a-f0-9]{40}$/);

    const post = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-land-authz",
          commit_message: "feat(core): dispatch-land authz side effect",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main") {
            return { code: 0, stdout: `${realCommit}\n`, stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(post.status).toBe(202);
    const accepted = (await post.json()) as any;
    const terminal = await waitForLandTask(svc, accepted.task_id);
    expect(terminal.status).toBe("done");

    const row = svc.db
      .query<
        {
          session_id: string | null;
          basis_type: string | null;
          basis_detail: string | null;
          basis: string | null;
          authorized_by_handoff: string | null;
        },
        [string]
      >(
        `SELECT session_id, basis_type, basis_detail, basis, authorized_by_handoff
         FROM t2_memory_verification_events
         WHERE memory_id = ?`,
      )
      .get("m-land-authz");
    expect(row).toBeDefined();
    expect(row?.session_id).toBe("h-land-authz");
    expect(row?.basis_type).toBe("dispatch_land");
    expect(row?.authorized_by_handoff).toBe("h-reviewer-authz");
    const basis = JSON.parse(row?.basis ?? "{}") as Record<string, unknown>;
    expect(basis.kind).toBe("dispatch_land");
    expect(basis.reviewer_handoff).toBe("h-reviewer-authz");
    expect(basis.merge_commit).toBe(realCommit);
  });

  test("ff mode runs ff-only merge and leaves branch when delete_branch=false", async () => {
    const svc = services();
    seedHandoff(svc, "h-2", "c-2");
    writeVerdictEvent(svc, {
      eventId: "v-2",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-2",
      conversationId: "c-2",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: Array<string> = [];
    let revParseCount = 0;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-2",
          commit_message: "chore: ignored by ff",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          gitCalls.push(args.join(" "));
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "ff-main\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:03:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe("ff-main");
    expect(body.result.branch_deleted).toBe(false);
    expect(body.result.pr_closed).toBe(false);
    expect(gitCalls).toEqual(["rev-parse main", "merge --ff-only agent/h-2", "rev-parse main"]);
  });

  test("returns 409 verdict_unverified when reconciler verdict failed", async () => {
    const svc = services();
    seedHandoff(svc, "h-3", "c-3");
    writeVerdictEvent(svc, {
      eventId: "v-3",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-3",
      conversationId: "c-3",
      typecheck: "pass",
      tests: "fail",
    });

    let called = false;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-3",
          commit_message: "feat: should not land",
        }),
      }),
      svc,
      {
        runGit: async () => {
          called = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(409);
    expect(called).toBe(false);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("verdict_unverified");
    expect(body.error.verdict.tests).toBe("fail");
  });

  test("auto-accepts verdict_unverified gate when dispatch audit is trustworthy + recommends accept", async () => {
    const svc = services();
    seedHandoff(svc, "h-audit-accept", "c-audit-accept");
    writeVerdictEvent(svc, {
      eventId: "v-audit-accept",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-audit-accept",
      conversationId: "c-audit-accept",
      typecheck: "pass",
      tests: "fail",
    });

    svc.db
      .query<
        unknown,
        [string, string, string]
      >(`UPDATE handoffs SET status='completed', worker_id=?, resolved_at=? WHERE handoff_id=?`)
      .run("worker-1", "2026-05-08T00:03:00.000Z", "h-audit-accept");
    svc.dispatchEventLog.recordBatch([
      {
        handoff_id: "h-audit-accept",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-08T00:01:10.000Z",
      },
      {
        handoff_id: "h-audit-accept",
        worker_id: "worker-1",
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-05-08T00:01:11.000Z",
      },
      {
        handoff_id: "h-audit-accept",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-05-08T00:02:10.000Z",
      },
    ]);
    svc.t0Writer.write({
      event_id: "resp-audit-accept",
      ts: "2026-05-08T00:02:20.000Z",
      ingest_ts: "2026-05-08T00:02:20.000Z",
      source: "agentchat",
      source_detail: "codex",
      project_id: null,
      user_id: "codex",
      machine_id: "machine-1",
      session_id: "c-audit-accept",
      event_type: "agent-response",
      lane: "local",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_json: { response: "done" },
      payload_summary: "done",
    });

    let revParseCount = 0;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-audit-accept",
          commit_message: "feat(core): audit-accept gate bypass",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe("new-main");
  });

  test("returns 409 merge_conflict with conflicted files, resets squash state, and allows a second land", async () => {
    const svc = services();
    seedHandoff(svc, "h-4", "c-4");
    seedHandoff(svc, "h-4-clean", "c-4-clean");
    writeVerdictEvent(svc, {
      eventId: "v-4",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-4",
      conversationId: "c-4",
      typecheck: "pass",
      tests: "pass",
    });
    writeVerdictEvent(svc, {
      eventId: "v-4-clean",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-4-clean",
      conversationId: "c-4-clean",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: Array<string> = [];
    let dirtyIndex = false;
    let revParseCount = 0;
    const deps = {
      runGit: async (args: string[]) => {
        const cmd = args.join(" ");
        gitCalls.push(cmd);
        if (cmd === "rev-parse main") {
          revParseCount += 1;
          return {
            code: 0,
            stdout: revParseCount === 3 ? "main-after-second-land\n" : "main-before\n",
            stderr: "",
          };
        }
        if (cmd === "checkout main") {
          if (dirtyIndex)
            return { code: 1, stdout: "", stderr: "you need to resolve your current index first" };
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "merge --squash agent/h-4") {
          dirtyIndex = true;
          return { code: 1, stdout: "", stderr: "CONFLICT (content)" };
        }
        if (cmd === "diff --name-only --diff-filter=U")
          return { code: 0, stdout: "a.txt\nb.ts\n", stderr: "" };
        if (cmd === "reset --merge") {
          dirtyIndex = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "status --porcelain --untracked-files=no")
          return { code: 0, stdout: dirtyIndex ? "UU a.txt\n" : "", stderr: "" };
        if (cmd === "merge --squash agent/h-4-clean") return { code: 0, stdout: "", stderr: "" };
        if (cmd === "commit -F -") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      gh: {
        listOpenPullRequestsByHead: async () => [],
        closePullRequest: async () => {},
      },
      now: () => new Date("2026-05-08T00:04:00.000Z"),
    } as any;

    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-4",
          commit_message: "feat: conflict",
          mode: "squash",
        }),
      }),
      svc,
      deps,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("merge_conflict");
    expect(body.error.files).toEqual(["a.txt", "b.ts"]);
    expect(dirtyIndex).toBe(false);
    expect(gitCalls.slice(0, 6)).toEqual([
      "rev-parse main",
      "checkout main",
      "merge --squash agent/h-4",
      "diff --name-only --diff-filter=U",
      "reset --merge",
      "status --porcelain --untracked-files=no",
    ]);

    const retry = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-4-clean",
          commit_message: "feat: clean retry",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      deps,
    );
    expect(retry.status).toBe(202);
    const retryAccepted = (await retry.json()) as any;
    const retryBody = await waitForLandTask(svc, retryAccepted.task_id);
    expect(retryBody.status).toBe("done");
    expect(retryBody.result.commit_sha).toBe("main-after-second-land");
    expect(gitCalls).not.toContain("merge --abort");
  });

  test("surfaces squash conflict cleanup failure with manual repair details", async () => {
    const svc = services();
    seedHandoff(svc, "h-conflict-cleanup-fails", "c-conflict-cleanup-fails");
    writeVerdictEvent(svc, {
      eventId: "v-conflict-cleanup-fails",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-conflict-cleanup-fails",
      conversationId: "c-conflict-cleanup-fails",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: Array<string> = [];
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-conflict-cleanup-fails",
          commit_message: "feat: conflict cleanup fails",
          mode: "squash",
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          const cmd = args.join(" ");
          gitCalls.push(cmd);
          if (cmd === "rev-parse main") return { code: 0, stdout: "main-before\n", stderr: "" };
          if (cmd === "checkout main") return { code: 0, stdout: "", stderr: "" };
          if (cmd === "merge --squash agent/h-conflict-cleanup-fails")
            return { code: 1, stdout: "", stderr: "CONFLICT (content)" };
          if (cmd === "diff --name-only --diff-filter=U")
            return { code: 0, stdout: "packages/core/src/index.ts\n", stderr: "" };
          if (cmd === "reset --merge")
            return {
              code: 1,
              stdout: "",
              stderr: "Entry 'packages/core/src/index.ts' not uptodate",
            };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("merge_conflict_cleanup_failed");
    expect(body.error.files).toEqual(["packages/core/src/index.ts"]);
    expect(body.error.cleanup_stderr).toContain("not uptodate");
    expect(body.error.manual_repair).toBe(
      "run git reset --merge in the target repo before retrying",
    );
    expect(gitCalls).toEqual([
      "rev-parse main",
      "checkout main",
      "merge --squash agent/h-conflict-cleanup-fails",
      "diff --name-only --diff-filter=U",
      "reset --merge",
    ]);
  });

  test("cleans the squash state when the merge fails without reported conflicts", async () => {
    const svc = services();
    seedHandoff(svc, "h-squash-noconflict", "c-squash-noconflict");
    writeVerdictEvent(svc, {
      eventId: "v-squash-noconflict",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-squash-noconflict",
      conversationId: "c-squash-noconflict",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: Array<string> = [];
    const deps = {
      runGit: async (args: string[]) => {
        const cmd = args.join(" ");
        gitCalls.push(cmd);
        if (cmd === "rev-parse main") return { code: 0, stdout: "main-before\n", stderr: "" };
        if (cmd === "merge --squash agent/h-squash-noconflict")
          return { code: 1, stdout: "", stderr: "fatal: working tree has modifications" };
        if (cmd === "diff --name-only --diff-filter=U") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      gh: {
        listOpenPullRequestsByHead: async () => [],
        closePullRequest: async () => {},
      },
      now: () => new Date("2026-05-08T00:06:00.000Z"),
    } as any;

    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-squash-noconflict",
          commit_message: "feat: squash fails without conflicts",
          mode: "squash",
        }),
      }),
      svc,
      deps,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("git_failed");
    expect(body.error.step).toBe("merge_squash");
    expect(gitCalls).toContain("reset --merge");
    expect(gitCalls).toContain("status --porcelain --untracked-files=no");
  });

  test("returns typed hook error and resets staged squash residue when commit hook rejects", async () => {
    const svc = services();
    seedHandoff(svc, "h-hook-fails", "c-hook-fails");
    writeVerdictEvent(svc, {
      eventId: "v-hook-fails",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-hook-fails",
      conversationId: "c-hook-fails",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: Array<string> = [];
    let stagedSquashResidue = false;
    let revParseCount = 0;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-hook-fails",
          commit_message: "feat: hook rejected",
          mode: "squash",
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          const cmd = args.join(" ");
          gitCalls.push(cmd);
          if (cmd === "rev-parse main") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "main-before\n" : "main-after\n",
              stderr: "",
            };
          }
          if (cmd === "merge --squash agent/h-hook-fails") {
            stagedSquashResidue = true;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (cmd === "commit -F -")
            return {
              code: 1,
              stdout: "",
              stderr: "pre-commit hook failed\nprettier --check packages/core/src/index.ts\n",
            };
          if (cmd === "reset --merge") {
            stagedSquashResidue = false;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (cmd === "status --porcelain --untracked-files=no")
            return {
              code: 0,
              stdout: stagedSquashResidue ? "M  packages/core/src/index.ts\n" : "",
              stderr: "",
            };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("commit_hook_failed");
    expect(body.error.step).toBe("commit_squash");
    expect(body.error.stderr).toContain("pre-commit hook failed");
    expect(stagedSquashResidue).toBe(false);
    expect(gitCalls).toEqual([
      "rev-parse main",
      "checkout main",
      "merge --squash agent/h-hook-fails",
      "commit -F -",
      "reset --merge",
      "status --porcelain --untracked-files=no",
    ]);
  });

  test("returns 409 merge_conflict with files from reconciler verdict when rebase_result=conflict", async () => {
    const svc = services();
    seedHandoff(svc, "h-4b", "c-4b");
    svc.t0Writer.write({
      event_id: "v-4b",
      ts: "2026-05-08T00:01:00.000Z",
      ingest_ts: "2026-05-08T00:01:00.000Z",
      source: "agentchat",
      source_detail: "merge-reconciler",
      project_id: null,
      user_id: "local-user",
      machine_id: "machine-1",
      session_id: "c-4b",
      event_type: "reconciler.verdict",
      lane: "local",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_json: {
        handoff_id: "h-4b",
        conversation_id: "c-4b",
        branch: "agent/h-4b",
        typecheck: "pass",
        tests: "pass",
        files_changed: 1,
        lines_added: 1,
        lines_deleted: 0,
        ff_mergeable: false,
        rebase_required: true,
        rebase_attempted: true,
        rebase_result: "conflict",
        rebase_conflict_files: ["packages/core/src/a.ts", "packages/daemon/src/b.ts"],
        summary: "rebase conflict",
      },
      payload_summary: "rebase conflict",
    });

    let called = false;
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-4b",
          commit_message: "feat: conflict",
          mode: "squash",
        }),
      }),
      svc,
      {
        runGit: async () => {
          called = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(409);
    expect(called).toBe(false);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("merge_conflict");
    expect(body.error.files).toEqual(["packages/core/src/a.ts", "packages/daemon/src/b.ts"]);
  });

  test("success path uses teardownWorktree return for branch_deleted + worktree_torn_down", async () => {
    const svc = services();
    seedHandoff(svc, "h-wt-1", "c-wt-1");
    writeVerdictEvent(svc, {
      eventId: "v-wt-1",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-wt-1",
      conversationId: "c-wt-1",
      typecheck: "pass",
      tests: "pass",
    });

    const teardownCalls: Array<{
      handoffId: string;
      force: boolean | undefined;
      projectId: string | undefined;
      deleteBranch: boolean | undefined;
    }> = [];
    (svc.worktreeManager as any).teardownWorktree = async (
      handoffId: string,
      force?: boolean,
      projectId?: string,
      deleteBranch?: boolean,
    ) => {
      teardownCalls.push({ handoffId, force, projectId, deleteBranch });
      return { worktreeRemoved: true, branchDeleted: true };
    };

    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-wt-1",
          commit_message: "feat: worktree teardown test",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-wt-1\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: { listOpenPullRequestsByHead: async () => [], closePullRequest: async () => {} },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.worktree_torn_down).toBe(true);
    expect(body.result.branch_deleted).toBe(true);
    expect(teardownCalls).toEqual([
      { handoffId: "h-wt-1", force: false, projectId: undefined, deleteBranch: false },
    ]);
  });

  test("teardownWorktree failure is logged but does not fail the land", async () => {
    const svc = services();
    seedHandoff(svc, "h-wt-2", "c-wt-2");
    writeVerdictEvent(svc, {
      eventId: "v-wt-2",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-wt-2",
      conversationId: "c-wt-2",
      typecheck: "pass",
      tests: "pass",
    });

    (svc.worktreeManager as any).teardownWorktree = async () => {
      throw new Error("simulated teardown failure");
    };

    const warnCalls: Array<unknown[]> = [];
    (svc as any).log = { warn: (...args: unknown[]) => warnCalls.push(args) };

    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-wt-2",
          commit_message: "feat: teardown failure should not block land",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-wt-2\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: { listOpenPullRequestsByHead: async () => [], closePullRequest: async () => {} },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.ok).toBe(true);
    expect(body.result.worktree_torn_down).toBe(false);
    expect(warnCalls.some((args) => String(args[1] ?? args[0]).includes("teardown failed"))).toBe(
      true,
    );
  });

  test("teardownWorktree non-throwing false result reports worktree_torn_down=false", async () => {
    const svc = services();
    seedHandoff(svc, "h-wt-3", "c-wt-3");
    writeVerdictEvent(svc, {
      eventId: "v-wt-3",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-wt-3",
      conversationId: "c-wt-3",
      typecheck: "pass",
      tests: "pass",
    });

    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: false,
      branchDeleted: false,
    });

    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-wt-3",
          commit_message: "feat: truthful teardown flag",
          mode: "squash",
          delete_branch: true,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-wt-3\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: { listOpenPullRequestsByHead: async () => [], closePullRequest: async () => {} },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.ok).toBe(true);
    expect(body.result.worktree_torn_down).toBe(false);
    expect(body.result.branch_deleted).toBe(false);
  });

  test("is silent about PR close when branch has no open PR", async () => {
    const svc = services();
    seedHandoff(svc, "h-5", "c-5");
    writeVerdictEvent(svc, {
      eventId: "v-5",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-5",
      conversationId: "c-5",
      typecheck: "pass",
      tests: "pass",
    });

    const closed: number[] = [];
    const res = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-5",
          commit_message: "feat: no pr",
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "same-main\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async (input: { number: number }) => {
            closed.push(input.number);
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = (await res.json()) as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.pr_closed).toBe(false);
    expect(closed).toEqual([]);
  });
});
