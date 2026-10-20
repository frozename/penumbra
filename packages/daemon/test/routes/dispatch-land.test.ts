import { DispatchLandAcceptedSchema, DispatchLandTaskSchema } from "@penumbra/api-contract";
import {
  buildServices,
  captureAgentPerformanceFromReconciler,
  closeLane,
  getLane,
  insertLane,
  loadSqliteVec,
  type Logger,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setPrincipalForTest } from "@src/auth.js";
import {
  __dispatchLandInternalsForTest,
  type DispatchLandDeps,
  dispatchLandRoute,
  dispatchLandTaskRoute,
} from "@src/routes/dispatch-land.js";
import { lanesCloseRoute } from "@src/routes/lanes.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { runOrphanLanesSweep } from "@src/sweepers/orphan-lanes.js";

// dispatch-land tests bypass the daemon fetch handler (they pass mocked deps
// directly to dispatchLandRoute), so the auth middleware never runs. Stamp a
// shared principal on each request so the route's principal guard does not
// 403 every existing test.
function landReq(input: string, init?: RequestInit): Request {
  const req = new Request(input, init);
  setPrincipalForTest(req, { kind: "shared", via: "config" });
  return req;
}

// Internal types of DispatchLandDeps are not exported; derive them through
// the public deps type so this test does not import internal shapes.
type RunGitFn = DispatchLandDeps["runGit"];
type RunGitResult = Awaited<ReturnType<RunGitFn>>;
type RunGitOpts = NonNullable<Parameters<RunGitFn>[1]>;
type ListPrsByHead = NonNullable<DispatchLandDeps["gh"]["listOpenPullRequestsByHead"]>;
type GhPullRequestLite = Awaited<ReturnType<ListPrsByHead>>[number];
type ClosePullRequest = NonNullable<DispatchLandDeps["gh"]["closePullRequest"]>;
type GhClosePullRequestInput = Parameters<ClosePullRequest>[0];
type MergePullRequest = NonNullable<DispatchLandDeps["gh"]["mergePullRequest"]>;
type GhMergePullRequestInput = Parameters<MergePullRequest>[0];
type GetPullRequest = NonNullable<DispatchLandDeps["gh"]["getPullRequest"]>;
type GhPullRequestView = Awaited<ReturnType<GetPullRequest>>;

// File-local typed envelopes for the dispatch-land HTTP responses. The route
// emits the shapes captured here; the assertions in this file only read these
// fields. Keeping them local avoids exposing/refactoring the route module.
interface LandResult {
  ok: boolean;
  commit_sha?: string;
  message_subject?: string;
  branch_deleted?: boolean;
  pr_closed?: boolean;
  worktree_torn_down?: boolean;
  already_landed?: boolean;
  pr_merged?: boolean;
  pr_number?: number;
}
interface LandError {
  code: string;
  check?: string;
  step?: string;
  files?: string[];
  stderr?: string;
  dirty_status?: string;
  cleanup_stderr?: string;
  manual_repair?: string;
  beforeMain?: string;
  afterMain?: string;
  verdict_head_sha?: string;
  branch_head_sha?: string;
  verdict?: { tests?: string; typecheck?: string; head_sha?: string };
  message?: string;
  local_sha?: string;
  remote_sha?: string;
  branch?: string;
  pr_number?: number;
  pr_state?: string;
}
interface AcceptedBody {
  ok?: boolean;
  task_id: string;
  status: "queued" | "running" | "done" | "failed";
  idempotent?: boolean;
}
interface LandTaskBody {
  task_id: string;
  handoff_id: string;
  status: "queued" | "running" | "done" | "failed";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: LandResult | null;
  error: LandError | null;
}
interface ErrorEnvelope {
  error: LandError;
}

async function readJsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Convert a synchronous mock implementation into the Promise-returning shape
// the route expects. Centralises the single `Promise.resolve` wrapping needed
// across ~30 inline mocks (eslint require-await: non-async + Promise.resolve).
type SyncRunGit = (args: string[], opts?: RunGitOpts) => RunGitResult;
type SyncListPrs = (head: string) => GhPullRequestLite[];
type SyncClosePr = (input: GhClosePullRequestInput) => void;
type SyncMergePr = (input: GhMergePullRequestInput) => void;
type SyncGetPr = (prNumber: number) => GhPullRequestView;
interface LandDepsInput {
  runGit: SyncRunGit;
  gh?: {
    listOpenPullRequestsByHead?: SyncListPrs;
    closePullRequest?: SyncClosePr;
    mergePullRequest?: SyncMergePr;
    getPullRequest?: SyncGetPr;
  };
  now?: () => Date;
}
function defaultListPrs(): GhPullRequestLite[] {
  return [];
}
function defaultClosePr(): void {
  /* no-op default */
}
function defaultMergePr(): void {
  /* no-op default */
}
function defaultGetPr(): GhPullRequestView {
  return { number: 0, state: "MERGED", mergeCommitOid: "default-merge-oid" };
}
function defaultNow(): Date {
  return new Date("2026-05-08T00:00:00.000Z");
}
function landDeps(input: LandDepsInput): DispatchLandDeps {
  const listPrs: SyncListPrs = input.gh?.listOpenPullRequestsByHead ?? defaultListPrs;
  const closePr: SyncClosePr = input.gh?.closePullRequest ?? defaultClosePr;
  const mergePr: SyncMergePr = input.gh?.mergePullRequest ?? defaultMergePr;
  const getPr: SyncGetPr = input.gh?.getPullRequest ?? defaultGetPr;
  return {
    runGit: (args, opts): Promise<RunGitResult> => Promise.resolve(input.runGit(args, opts)),
    gh: {
      listOpenPullRequestsByHead: (head): Promise<GhPullRequestLite[]> =>
        Promise.resolve(listPrs(head)),
      closePullRequest: (closeInput): Promise<void> => {
        closePr(closeInput);
        return Promise.resolve();
      },
      mergePullRequest: (mergeInput): Promise<void> => {
        mergePr(mergeInput);
        return Promise.resolve();
      },
      getPullRequest: (prNumber): Promise<GhPullRequestView> => Promise.resolve(getPr(prNumber)),
    },
    now: input.now ?? defaultNow,
  };
}

// teardownWorktree is a class instance method; tests stub it by reassignment.
// Centralise the typed assignment so callers do not need to think about it.
type TeardownFn = Services["worktreeManager"]["teardownWorktree"];
function stubTeardownWorktree(svc: Services, impl: TeardownFn): void {
  svc.worktreeManager.teardownWorktree = impl;
}

// ProjectRegistry has a private field, so build a real instance from a Map.
function stubProjectRegistry(
  svc: Services,
  entries: Iterable<[string, { root_path: string }]>,
): void {
  const map = new Map<string, { project_id: string; root_path: string }>();
  for (const [id, entry] of entries) {
    map.set(id, { project_id: id, root_path: entry.root_path });
  }
  svc.projectRegistry = new ProjectRegistry(map);
}

// Tests only stub a subset of the Logger surface (typically just `warn`).
function stubLogWarn(svc: Services, warn: (...args: unknown[]) => void): void {
  // pino Logger has many overloaded methods; tests only need `warn` here.
  svc.log = { warn } as unknown as Logger;
}

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
    uuid: () => `id-${String(++n)}`,
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
    recalledMemoryIds?: string[];
  },
): void {
  insertLane(svc.db, {
    lane_id: input.laneId,
    ts_opened: "2026-05-08T00:00:00.000Z",
    task_class: "STANDARD",
    implementer_handoff: input.implementerHandoff,
    recalled_memory_ids: input.recalledMemoryIds ?? [],
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

function runGitSync(
  repoDir: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repoDir, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function expectGitOk(repoDir: string, args: string[]): string {
  const result = runGitSync(repoDir, args);
  expect(result.code, `git ${args.join(" ")} stderr=${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function writeVerdictEvent(
  svc: Services,
  input: {
    eventId: string;
    ts: string;
    handoffId: string;
    conversationId: string;
    headSha?: string;
    typecheck: "pass" | "fail" | "error";
    tests: "pass" | "fail" | "error" | "skipped";
  },
): void {
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
      head_sha: input.headSha ?? `head-${input.handoffId}`,
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
): void {
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

async function waitForLandTask(svc: Services, taskId: string): Promise<LandTaskBody> {
  for (let i = 0; i < 30; i += 1) {
    const res = dispatchLandTaskRoute(new Request(`http://x/dispatch/land/${taskId}`), svc, taskId);
    expect(res.status).toBe(200);
    const body = await readJsonAs<LandTaskBody>(res);
    if (body.status === "done" || body.status === "failed") return body;
    await Bun.sleep(5);
  }
  throw new Error(`task ${taskId} did not finish`);
}

// Lookup-table-driven runGit mock for the squash conflict + clean retry test.
// Extracted out of the test body so the inline mock does not hit the sonarjs
// cognitive-complexity cap (the test asserts on many distinct branches).
interface ConflictMockState {
  getDirty: () => boolean;
  setDirty: (next: boolean) => void;
  incRevParse: () => number;
}
function runGitConflict(
  args: string[],
  gitCalls: string[],
  state: ConflictMockState,
): RunGitResult {
  const cmd = args.join(" ");
  gitCalls.push(cmd);
  const handler = CONFLICT_HANDLERS[cmd];
  if (handler) return handler(state);
  return { code: 0, stdout: "", stderr: "" };
}
const CONFLICT_HANDLERS: Record<string, (s: ConflictMockState) => RunGitResult> = {
  "rev-parse main": (s) => ({
    code: 0,
    stdout: s.incRevParse() === 3 ? "main-after-second-land\n" : "main-before\n",
    stderr: "",
  }),
  "checkout main": (s) =>
    s.getDirty()
      ? { code: 1, stdout: "", stderr: "you need to resolve your current index first" }
      : { code: 0, stdout: "", stderr: "" },
  "merge --squash agent/h-4": (s) => {
    s.setDirty(true);
    return { code: 1, stdout: "", stderr: "CONFLICT (content)" };
  },
  "diff --name-only --diff-filter=U": () => ({
    code: 0,
    stdout: "a.txt\nb.ts\n",
    stderr: "",
  }),
  "reset --merge": (s) => {
    s.setDirty(false);
    return { code: 0, stdout: "", stderr: "" };
  },
  "status --porcelain --untracked-files=no": (s) => ({
    code: 0,
    stdout: s.getDirty() ? "UU a.txt\n" : "",
    stderr: "",
  }),
  "merge --squash agent/h-4-clean": () => ({ code: 0, stdout: "", stderr: "" }),
  "diff --cached --quiet": () => ({ code: 1, stdout: "", stderr: "" }),
  "commit -F -": () => ({ code: 0, stdout: "", stderr: "" }),
};

describe("dispatchLandRoute", () => {
  test("serve.ts wires authenticated POST /dispatch/land", async () => {
    const svc = services();
    const handler = createDaemonFetchHandler({ services: svc, token: "tok" });
    const res = await handler(
      landReq("http://x/dispatch/land", {
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
    const body = await readJsonAs<ErrorEnvelope>(res);
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

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    const gitCalls: string[] = [];
    let revParseCount = 0;
    const post = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-msg-tip",
          mode: "ff",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
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
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(post.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(post);
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
    const runGitCwd: (string | undefined)[] = [];
    stubProjectRegistry(svc, [["other-project", { root_path: "/tmp/other-repo-path" }]]);

    const post = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-project",
          commit_message: "feat(core): cross-repo land",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[], opts?: { stdin?: string; cwd?: string }) => {
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
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(post.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(post);
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-async-1",
          commit_message: "feat(core): async land",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(post.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(post);
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-sha-tip",
          commit_message: "feat(core): sha tip lock",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
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
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
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

    const gitCalls: { args: string[]; stdin?: string }[] = [];
    let revParseCount = 0;
    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );
    const deps = landDeps({
      runGit: (args, opts) => {
        gitCalls.push({ args, stdin: opts?.stdin });
        if (args[0] === "rev-parse" && args[1] === "main") {
          revParseCount += 1;
          return { code: 0, stdout: revParseCount === 1 ? "old-main\n" : "new-main\n", stderr: "" };
        }
        if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
          return { code: 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      gh: {
        listOpenPullRequestsByHead: (head) => {
          if (head !== "agent/h-1") throw new Error(`unexpected head ${head}`);
          return [{ number: 77 }];
        },
        closePullRequest: () => {
          /* recorded by the test below via closed.push */
        },
      },
      now: () => new Date("2026-05-08T00:02:00.000Z"),
    });

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-1",
          commit_message: "feat(core): curated subject\n\nbody details",
          mode: "squash",
          delete_branch: true,
        }),
      }),
      svc,
      deps,
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.ok).toBe(true);
    expect(body.result.commit_sha).toBe("new-main");
    expect(body.result.message_subject).toBe("feat(core): curated subject");
    expect(body.result.branch_deleted).toBe(true);
    expect(body.result.pr_closed).toBe(true);

    expect(gitCalls.map((c) => c.args.join(" "))).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --squash agent/h-1",
      "diff --cached --quiet",
      "commit -F -",
      "rev-parse main",
    ]);
    expect(gitCalls[5]?.stdin).toBe("feat(core): curated subject\n\nbody details");

    const landed = svc.db
      .query<
        { event_type: string; payload_json: string },
        []
      >(`SELECT event_type, payload_json FROM t0_events WHERE event_type='dispatch.landed' ORDER BY ts DESC LIMIT 1`)
      .get();
    expect(landed?.event_type).toBe("dispatch.landed");
    const payload = JSON.parse(landed?.payload_json ?? "{}") as Record<string, unknown>;
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-restamp-1",
          commit_message: "feat(core): restamp performance",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
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

  test("squash re-land with no staged changes returns already_landed without restamping performance", async () => {
    const svc = services();
    seedHandoff(svc, "h-squash-reland", "c-squash-reland");
    writeVerdictEvent(svc, {
      eventId: "v-squash-reland",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-squash-reland",
      conversationId: "c-squash-reland",
      typecheck: "pass",
      tests: "pass",
    });
    seedAgentPerformanceRow(svc, {
      performanceId: "perf-squash-reland",
      ts: "2026-05-08T00:01:30.000Z",
      handoffId: "h-squash-reland",
      conversationId: "c-squash-reland",
      projectId: null,
      agentName: "codex",
      taskType: "implement_small",
      outcome: "no_changes",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    const gitCalls: string[] = [];
    const closed: number[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-squash-reland",
          commit_message: "feat: already landed squash",
          mode: "squash",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          const cmd = args.join(" ");
          gitCalls.push(cmd);
          if (cmd === "rev-parse main") {
            return { code: 0, stdout: "same-main\n", stderr: "" };
          }
          if (cmd === "diff --cached --quiet") {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (cmd === "commit -F -") {
            return { code: 1, stdout: "", stderr: "nothing to commit, working tree clean\n" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 88 }],
          closePullRequest: (input: { number: number }) => {
            closed.push(input.number);
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      commit_sha: "same-main",
      already_landed: true,
      branch_deleted: true,
      worktree_torn_down: true,
      pr_closed: false,
    });
    expect(gitCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --squash agent/h-squash-reland",
      "diff --cached --quiet",
      "rev-parse main",
    ]);
    expect(closed).toEqual([]);

    const landedCount = svc.db
      .query<
        { count: number },
        []
      >(`SELECT COUNT(*) AS count FROM t0_events WHERE event_type='dispatch.landed'`)
      .get();
    expect(landedCount?.count).toBe(0);
    const perf = svc.db
      .query<
        { outcome: string; gate_outcome: string | null },
        [string]
      >(`SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-squash-reland");
    expect(perf).toEqual({ outcome: "no_changes", gate_outcome: null });
  });

  test("post-merge auto-authorizes memory verify with dispatch_land basis", async () => {
    const svc = services();
    seedHandoff(svc, "h-land-authz", "c-land-authz");
    seedHandoff(svc, "h-reviewer-authz", "c-reviewer-authz");
    seedClosedLaneWithReviewer(svc, {
      laneId: "lane-land-authz",
      implementerHandoff: "h-land-authz",
      reviewerHandoff: "h-reviewer-authz",
      recalledMemoryIds: ["m-land-authz"],
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

    const realCommit = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(realCommit).toMatch(/^[a-f0-9]{40}$/);

    const post = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-land-authz",
          commit_message: "feat(core): dispatch-land authz side effect",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main") {
            return { code: 0, stdout: `${realCommit}\n`, stderr: "" };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(post.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(post);
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

  test("memory-verify authorize throw does not flip a successful land to failed", async () => {
    const svc = services();
    seedHandoff(svc, "h-land-authz-throw", "c-land-authz-throw");
    seedHandoff(svc, "h-reviewer-authz-throw", "c-reviewer-authz-throw");
    seedClosedLaneWithReviewer(svc, {
      laneId: "lane-land-authz-throw",
      implementerHandoff: "h-land-authz-throw",
      reviewerHandoff: "h-reviewer-authz-throw",
      recalledMemoryIds: ["m-land-authz-throw"],
    });
    writeVerdictEvent(svc, {
      eventId: "v-land-authz-throw",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-land-authz-throw",
      conversationId: "c-land-authz-throw",
      typecheck: "pass",
      tests: "pass",
    });
    seedMemory(svc.db, "m-land-authz-throw");

    // Force the memory-verify authorize side-effect to throw by dropping the
    // verification-events table out from under it. The land itself has already
    // succeeded by this point; the throw must not flip the result to failed.
    svc.db.run("DROP TABLE t2_memory_verification_events");

    const realCommit = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(realCommit).toMatch(/^[a-f0-9]{40}$/);

    const post = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-land-authz-throw",
          commit_message: "feat(core): land succeeds despite memory-verify throw",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main") {
            return { code: 0, stdout: `${realCommit}\n`, stderr: "" };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(post.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(post);
    const terminal = await waitForLandTask(svc, accepted.task_id);
    expect(terminal.status).toBe("done");
    expect(terminal.error).toBeNull();
    expect(terminal.result).toMatchObject({
      ok: true,
      commit_sha: realCommit,
    });
    expect(terminal.result.already_landed).toBeUndefined();
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

    const gitCalls: string[] = [];
    let revParseCount = 0;
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-2",
          commit_message: "chore: ignored by ff",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
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
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:03:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe("ff-main");
    expect(body.result.branch_deleted).toBe(false);
    expect(body.result.pr_closed).toBe(false);
    expect(gitCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --ff-only agent/h-2",
      "rev-parse main",
    ]);
  });

  test("ff mode fails before checkout when the target repo already has staged changes", async () => {
    const svc = services();
    seedHandoff(svc, "h-ff-dirty-before-land", "c-ff-dirty-before-land");
    writeVerdictEvent(svc, {
      eventId: "v-ff-dirty-before-land",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-ff-dirty-before-land",
      conversationId: "c-ff-dirty-before-land",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-ff-dirty-before-land",
          commit_message: "chore: ignored by ff",
          mode: "ff",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          const cmd = args.join(" ");
          gitCalls.push(cmd);
          if (cmd === "rev-parse main") return { code: 0, stdout: "base-main\n", stderr: "" };
          if (cmd === "status --porcelain --untracked-files=no")
            return { code: 0, stdout: "M  packages/core/src/index.ts\n", stderr: "" };
          if (cmd === "merge --ff-only agent/h-ff-dirty-before-land")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        now: () => new Date("2026-05-08T00:03:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("dirty_before_land");
    expect(body.error.dirty_status).toBe("M  packages/core/src/index.ts");
    expect(gitCalls).toEqual(["rev-parse main", "status --porcelain --untracked-files=no"]);
  });

  test("ff mode checks out main before merging when ambient HEAD is another branch", async () => {
    const svc = services();
    seedHandoff(svc, "h-ff-non-main", "c-ff-non-main", "project-ff-non-main");
    writeVerdictEvent(svc, {
      eventId: "v-ff-non-main",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-ff-non-main",
      conversationId: "c-ff-non-main",
      typecheck: "pass",
      tests: "pass",
    });

    const repoDir = mkdtempSync(join(tmpdir(), "dispatch-land-ff-"));
    expectGitOk(repoDir, ["init", "--initial-branch", "main"]);
    expectGitOk(repoDir, ["config", "user.email", "penumbra@example.test"]);
    expectGitOk(repoDir, ["config", "user.name", "Penumbra Test"]);
    writeFileSync(join(repoDir, "base.txt"), "base\n");
    expectGitOk(repoDir, ["add", "base.txt"]);
    expectGitOk(repoDir, ["commit", "-m", "base"]);
    const baseMain = expectGitOk(repoDir, ["rev-parse", "main"]);

    expectGitOk(repoDir, ["branch", "other"]);
    expectGitOk(repoDir, ["checkout", "-b", "agent/h-ff-non-main", "main"]);
    writeFileSync(join(repoDir, "agent.txt"), "agent\n");
    expectGitOk(repoDir, ["add", "agent.txt"]);
    expectGitOk(repoDir, ["commit", "-m", "feat: ff land"]);
    const agentTip = expectGitOk(repoDir, ["rev-parse", "agent/h-ff-non-main"]);
    expectGitOk(repoDir, ["checkout", "other"]);

    stubProjectRegistry(svc, [["project-ff-non-main", { root_path: repoDir }]]);
    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: false, branchDeleted: false }),
    );

    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-ff-non-main",
          commit_message: "feat: ff land",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[], opts?: { cwd?: string }) => {
          gitCalls.push(args.join(" "));
          return runGitSync(opts?.cwd ?? repoDir, args);
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:03:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe(agentTip);
    expect(expectGitOk(repoDir, ["rev-parse", "main"])).toBe(agentTip);
    expect(expectGitOk(repoDir, ["rev-parse", "other"])).toBe(baseMain);
    expect(gitCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --ff-only agent/h-ff-non-main",
      "rev-parse main",
    ]);
  });

  test("ff re-land already in main returns idempotent success without restamping", async () => {
    const svc = services();
    seedHandoff(svc, "h-ff-reland", "c-ff-reland");
    writeVerdictEvent(svc, {
      eventId: "v-ff-reland",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-ff-reland",
      conversationId: "c-ff-reland",
      typecheck: "pass",
      tests: "pass",
    });
    seedAgentPerformanceRow(svc, {
      performanceId: "perf-ff-reland",
      ts: "2026-05-08T00:01:30.000Z",
      handoffId: "h-ff-reland",
      conversationId: "c-ff-reland",
      projectId: null,
      agentName: "codex",
      taskType: "implement_small",
      outcome: "no_changes",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    const gitCalls: string[] = [];
    const closed: number[] = [];
    let revParseCount = 0;
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-ff-reland",
          commit_message: "feat: already landed",
          mode: "ff",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          gitCalls.push(args.join(" "));
          if (args[0] === "rev-parse" && args[1] === "main") {
            revParseCount += 1;
            return { code: 0, stdout: "same-main\n", stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 88 }],
          closePullRequest: (input: { number: number }) => {
            closed.push(input.number);
          },
        },
        now: () => new Date("2026-05-08T00:03:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      commit_sha: "same-main",
      already_landed: true,
      branch_deleted: true,
      worktree_torn_down: true,
      pr_closed: false,
    });
    expect(revParseCount).toBe(2);
    expect(gitCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --ff-only agent/h-ff-reland",
      "rev-parse main",
      "merge-base --is-ancestor agent/h-ff-reland main",
    ]);
    expect(closed).toEqual([]);

    const landedCount = svc.db
      .query<
        { count: number },
        []
      >(`SELECT COUNT(*) AS count FROM t0_events WHERE event_type='dispatch.landed'`)
      .get();
    expect(landedCount?.count).toBe(0);
    const perf = svc.db
      .query<
        { outcome: string; gate_outcome: string | null },
        [string]
      >(`SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-ff-reland");
    expect(perf).toEqual({ outcome: "no_changes", gate_outcome: null });
  });

  test("ff merge that does not advance main or leave branch in main fails verification", async () => {
    const svc = services();
    seedHandoff(svc, "h-ff-not-in-main", "c-ff-not-in-main");
    writeVerdictEvent(svc, {
      eventId: "v-ff-not-in-main",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-ff-not-in-main",
      conversationId: "c-ff-not-in-main",
      typecheck: "pass",
      tests: "pass",
    });
    seedAgentPerformanceRow(svc, {
      performanceId: "perf-ff-not-in-main",
      ts: "2026-05-08T00:01:30.000Z",
      handoffId: "h-ff-not-in-main",
      conversationId: "c-ff-not-in-main",
      projectId: null,
      agentName: "codex",
      taskType: "implement_small",
      outcome: "no_changes",
    });

    let teardownCalled = false;
    stubTeardownWorktree(svc, () => {
      teardownCalled = true;
      return Promise.resolve({ worktreeRemoved: true, branchDeleted: true });
    });

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-ff-not-in-main",
          commit_message: "feat: impossible merge",
          mode: "ff",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main") {
            return { code: 0, stdout: "stale-main\n", stderr: "" };
          }
          if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => {
            throw new Error("PR close should not run");
          },
          closePullRequest: () => {
            throw new Error("PR close should not run");
          },
        },
        now: () => new Date("2026-05-08T00:03:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error).toMatchObject({
      code: "land_not_in_main",
      step: "verify_landed",
      beforeMain: "stale-main",
      afterMain: "stale-main",
    });
    expect(teardownCalled).toBe(false);

    const landedCount = svc.db
      .query<
        { count: number },
        []
      >(`SELECT COUNT(*) AS count FROM t0_events WHERE event_type='dispatch.landed'`)
      .get();
    expect(landedCount?.count).toBe(0);
    const perf = svc.db
      .query<
        { outcome: string; gate_outcome: string | null },
        [string]
      >(`SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-ff-not-in-main");
    expect(perf).toEqual({ outcome: "no_changes", gate_outcome: null });
  });

  test("returns 409 verdict_unverified when reconciler verdict failed", async () => {
    const svc = services();
    const warnCalls: unknown[][] = [];
    stubLogWarn(svc, (...args: unknown[]) => {
      warnCalls.push(args);
    });
    seedHandoff(svc, "h-3", "c-3");
    writeVerdictEvent(svc, {
      eventId: "v-3",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-3",
      conversationId: "c-3",
      typecheck: "fail",
      tests: "pass",
    });

    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-3",
          commit_message: "feat: should not land",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          gitCalls.push(args.join(" "));
          if (args[0] === "rev-parse" && args[1] === "agent/h-3") {
            return { code: 0, stdout: "head-h-3\n", stderr: "" };
          }
          throw new Error(`unexpected land git call: ${args.join(" ")}`);
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
      }),
    );

    expect(res.status).toBe(409);
    expect(gitCalls).toEqual(["rev-parse agent/h-3"]);
    const body = await readJsonAs<ErrorEnvelope>(res);
    expect(body.error.code).toBe("verdict_unverified");
    expect(body.error.check).toBe("typecheck");
    expect(body.error.verdict_head_sha).toBe("head-h-3");
    expect(body.error.branch_head_sha).toBe("head-h-3");
    expect(body.error.verdict?.typecheck).toBe("fail");
    expect(warnCalls).toContainEqual([
      expect.objectContaining({
        reason: "hard_fail",
        handoff_id: "h-3",
        branch: "agent/h-3",
        check: "typecheck",
        verdict_head_sha: "head-h-3",
        branch_head_sha: "head-h-3",
      }),
      expect.stringContaining("verdict_unverified"),
    ]);
  });

  test("does not block landing when a hard-fail verdict is stale relative to branch head", async () => {
    const svc = services();
    seedHandoff(svc, "h-stale-verdict", "c-stale-verdict");
    writeVerdictEvent(svc, {
      eventId: "v-stale-verdict",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-stale-verdict",
      conversationId: "c-stale-verdict",
      headSha: "old-head",
      typecheck: "fail",
      tests: "pass",
    });
    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    let mainRevParseCount = 0;
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-stale-verdict",
          commit_message: "fix(daemon): land newer branch head",
          mode: "ff",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-stale-verdict") {
            return { code: 0, stdout: "new-head\n", stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "main") {
            mainRevParseCount += 1;
            return {
              code: 0,
              stdout: mainRevParseCount === 1 ? "before-main\n" : "after-main\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
  });

  test("rejects audit-accept gate bypass when reconciler verdict has hard test failure", async () => {
    const svc = services();
    seedHandoff(svc, "h-audit-hardfail", "c-audit-hardfail");
    writeVerdictEvent(svc, {
      eventId: "v-audit-hardfail",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-audit-hardfail",
      conversationId: "c-audit-hardfail",
      typecheck: "pass",
      tests: "fail",
    });

    // Seed the full trustworthy-dispatch trail so that, if the route were to
    // call isAuditTrustedAccept, it would return true. The point of this test
    // is that on a hard verdict failure, the audit-accept override must NOT
    // be consulted — force:true is the only path through.
    svc.db
      .query<
        unknown,
        [string, string, string]
      >(`UPDATE handoffs SET status='completed', worker_id=?, resolved_at=? WHERE handoff_id=?`)
      .run("worker-1", "2026-05-08T00:03:00.000Z", "h-audit-hardfail");
    svc.dispatchEventLog.recordBatch([
      {
        handoff_id: "h-audit-hardfail",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-08T00:01:10.000Z",
      },
      {
        handoff_id: "h-audit-hardfail",
        worker_id: "worker-1",
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-05-08T00:01:11.000Z",
      },
      {
        handoff_id: "h-audit-hardfail",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-05-08T00:02:10.000Z",
      },
    ]);
    svc.t0Writer.write({
      event_id: "resp-audit-hardfail",
      ts: "2026-05-08T00:02:20.000Z",
      ingest_ts: "2026-05-08T00:02:20.000Z",
      source: "agentchat",
      source_detail: "codex",
      project_id: null,
      user_id: "codex",
      machine_id: "machine-1",
      session_id: "c-audit-hardfail",
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

    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-audit-hardfail",
          commit_message: "feat(core): should not bypass hard fail",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          gitCalls.push(args.join(" "));
          if (args[0] === "rev-parse" && args[1] === "agent/h-audit-hardfail") {
            return { code: 0, stdout: "head-h-audit-hardfail\n", stderr: "" };
          }
          throw new Error(`unexpected land git call: ${args.join(" ")}`);
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(409);
    expect(gitCalls).toEqual(["rev-parse agent/h-audit-hardfail"]);
    const body = await readJsonAs<ErrorEnvelope>(res);
    expect(body.error.code).toBe("verdict_unverified");
    expect(body.error.check).toBe("tests");
    expect(body.error.verdict?.tests).toBe("fail");
  });

  test("auto-accepts missing verdict when dispatch audit is trustworthy + recommends accept", async () => {
    const svc = services();
    seedHandoff(svc, "h-audit-unverified", "c-audit-unverified");
    // Intentionally do NOT call writeVerdictEvent — the verdict is missing
    // (readLatestVerdict returns null), which is the case the audit-accept
    // override is supposed to rescue.

    svc.db
      .query<
        unknown,
        [string, string, string]
      >(`UPDATE handoffs SET status='completed', worker_id=?, resolved_at=? WHERE handoff_id=?`)
      .run("worker-1", "2026-05-08T00:03:00.000Z", "h-audit-unverified");
    svc.dispatchEventLog.recordBatch([
      {
        handoff_id: "h-audit-unverified",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-08T00:01:10.000Z",
      },
      {
        handoff_id: "h-audit-unverified",
        worker_id: "worker-1",
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-05-08T00:01:11.000Z",
      },
      {
        handoff_id: "h-audit-unverified",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-05-08T00:02:10.000Z",
      },
    ]);
    svc.t0Writer.write({
      event_id: "resp-audit-unverified",
      ts: "2026-05-08T00:02:20.000Z",
      ingest_ts: "2026-05-08T00:02:20.000Z",
      source: "agentchat",
      source_detail: "codex",
      project_id: null,
      user_id: "codex",
      machine_id: "machine-1",
      session_id: "c-audit-unverified",
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-audit-unverified",
          commit_message: "feat(core): audit-accept rescues missing verdict",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe("new-main");
  });

  test("returns 409 verdict_unverified when environment-error verdict lacks audit accept", async () => {
    const svc = services();
    const warnCalls: unknown[][] = [];
    stubLogWarn(svc, (...args: unknown[]) => {
      warnCalls.push(args);
    });
    seedHandoff(svc, "h-env-unverified", "c-env-unverified");
    writeVerdictEvent(svc, {
      eventId: "v-env-unverified",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-env-unverified",
      conversationId: "c-env-unverified",
      typecheck: "error",
      tests: "skipped",
    });

    let called = false;
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-env-unverified",
          commit_message: "feat(core): should not land unverified",
        }),
      }),
      svc,
      landDeps({
        runGit: () => {
          called = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
      }),
    );

    expect(res.status).toBe(409);
    expect(called).toBe(false);
    const body = await readJsonAs<ErrorEnvelope>(res);
    expect(body.error.code).toBe("verdict_unverified");
    expect(body.error.verdict?.typecheck).toBe("error");
    expect(warnCalls).toContainEqual([
      expect.objectContaining({
        reason: "unverified",
        handoff_id: "h-env-unverified",
        branch: "agent/h-env-unverified",
        verdict_state: "error",
        audit_trusted_accept: false,
      }),
      expect.stringContaining("verdict_unverified"),
    ]);
  });

  test("auto-accepts environment-error verdict when dispatch audit is trustworthy + recommends accept", async () => {
    const svc = services();
    seedHandoff(svc, "h-audit-envfail", "c-audit-envfail");
    writeVerdictEvent(svc, {
      eventId: "v-audit-envfail",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-audit-envfail",
      conversationId: "c-audit-envfail",
      typecheck: "error",
      tests: "skipped",
    });

    svc.db
      .query<
        unknown,
        [string, string, string]
      >(`UPDATE handoffs SET status='completed', worker_id=?, resolved_at=? WHERE handoff_id=?`)
      .run("worker-1", "2026-05-08T00:03:00.000Z", "h-audit-envfail");
    svc.dispatchEventLog.recordBatch([
      {
        handoff_id: "h-audit-envfail",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-08T00:01:10.000Z",
      },
      {
        handoff_id: "h-audit-envfail",
        worker_id: "worker-1",
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-05-08T00:01:11.000Z",
      },
      {
        handoff_id: "h-audit-envfail",
        worker_id: "worker-1",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-05-08T00:02:10.000Z",
      },
    ]);
    svc.t0Writer.write({
      event_id: "resp-audit-envfail",
      ts: "2026-05-08T00:02:20.000Z",
      ingest_ts: "2026-05-08T00:02:20.000Z",
      source: "agentchat",
      source_detail: "codex",
      project_id: null,
      user_id: "codex",
      machine_id: "machine-1",
      session_id: "c-audit-envfail",
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-audit-envfail",
          commit_message: "feat(core): audit-accept rescues environment error",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") {
            revParseCount += 1;
            return {
              code: 0,
              stdout: revParseCount === 1 ? "base-main\n" : "new-main\n",
              stderr: "",
            };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.commit_sha).toBe("new-main");
  });

  test("rejects worker-principal callers with 403 principal_forbidden", async () => {
    const svc = services();
    seedHandoff(svc, "h-worker-forbidden", "c-worker-forbidden");

    const req = new Request("http://x/dispatch/land", {
      method: "POST",
      body: JSON.stringify({
        handoff_id: "h-worker-forbidden",
        commit_message: "feat: should be blocked by authz",
      }),
    });
    setPrincipalForTest(req, {
      kind: "worker",
      worker_id: "worker-not-allowed",
      token_hash: "hash",
    });

    let runGitCalled = false;
    const res = await dispatchLandRoute(
      req,
      svc,
      landDeps({
        runGit: () => {
          runGitCalled = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );

    expect(res.status).toBe(403);
    expect(runGitCalled).toBe(false);
    const body = await readJsonAs<ErrorEnvelope>(res);
    expect(body.error.code).toBe("principal_forbidden");
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

    const gitCalls: string[] = [];
    let dirtyIndex = false;
    let revParseCount = 0;
    const deps = landDeps({
      runGit: (args) =>
        runGitConflict(args, gitCalls, {
          getDirty: () => dirtyIndex,
          setDirty: (v) => {
            dirtyIndex = v;
          },
          incRevParse: () => {
            revParseCount += 1;
            return revParseCount;
          },
        }),
      now: () => new Date("2026-05-08T00:04:00.000Z"),
    });

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
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
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("merge_conflict");
    expect(body.error.files).toEqual(["a.txt", "b.ts"]);
    expect(dirtyIndex).toBe(false);
    expect(gitCalls.slice(0, 7)).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --squash agent/h-4",
      "diff --name-only --diff-filter=U",
      "reset --merge",
      "status --porcelain --untracked-files=no",
    ]);

    const retry = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
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
    const retryAccepted = await readJsonAs<AcceptedBody>(retry);
    const retryBody = await waitForLandTask(svc, retryAccepted.task_id);
    expect(retryBody.status).toBe("done");
    expect(retryBody.result.commit_sha).toBe("main-after-second-land");
    expect(gitCalls).not.toContain("merge --abort");
  });

  test("squash mode fails before checkout when the target repo already has staged changes", async () => {
    const svc = services();
    seedHandoff(svc, "h-squash-dirty-before-land", "c-squash-dirty-before-land");
    writeVerdictEvent(svc, {
      eventId: "v-squash-dirty-before-land",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-squash-dirty-before-land",
      conversationId: "c-squash-dirty-before-land",
      typecheck: "pass",
      tests: "pass",
    });

    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-squash-dirty-before-land",
          commit_message: "feat: should not absorb stale staged files",
          mode: "squash",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          const cmd = args.join(" ");
          gitCalls.push(cmd);
          if (cmd === "rev-parse main") return { code: 0, stdout: "base-main\n", stderr: "" };
          if (cmd === "status --porcelain --untracked-files=no")
            return { code: 0, stdout: "A  fileA\n", stderr: "" };
          if (cmd === "merge --squash agent/h-squash-dirty-before-land")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("dirty_before_land");
    expect(body.error.dirty_status).toBe("A  fileA");
    expect(gitCalls).toEqual(["rev-parse main", "status --porcelain --untracked-files=no"]);
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

    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-conflict-cleanup-fails",
          commit_message: "feat: conflict cleanup fails",
          mode: "squash",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
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
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
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
      "status --porcelain --untracked-files=no",
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

    const gitCalls: string[] = [];
    const deps = landDeps({
      runGit: (args) => {
        const cmd = args.join(" ");
        gitCalls.push(cmd);
        if (cmd === "rev-parse main") return { code: 0, stdout: "main-before\n", stderr: "" };
        if (cmd === "merge --squash agent/h-squash-noconflict")
          return { code: 1, stdout: "", stderr: "fatal: working tree has modifications" };
        if (cmd === "diff --name-only --diff-filter=U") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => new Date("2026-05-08T00:06:00.000Z"),
    });

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
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
    const accepted = await readJsonAs<AcceptedBody>(res);
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

    const gitCalls: string[] = [];
    let stagedSquashResidue = false;
    let revParseCount = 0;
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-hook-fails",
          commit_message: "feat: hook rejected",
          mode: "squash",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
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
          if (cmd === "diff --cached --quiet") return { code: 1, stdout: "", stderr: "" };
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
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("commit_hook_failed");
    expect(body.error.step).toBe("commit_squash");
    expect(body.error.stderr).toContain("pre-commit hook failed");
    expect(stagedSquashResidue).toBe(false);
    expect(gitCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --squash agent/h-hook-fails",
      "diff --cached --quiet",
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-4b",
          commit_message: "feat: conflict",
          mode: "squash",
        }),
      }),
      svc,
      landDeps({
        runGit: () => {
          called = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
      }),
    );

    expect(res.status).toBe(409);
    expect(called).toBe(false);
    const body = await readJsonAs<ErrorEnvelope>(res);
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

    const teardownCalls: {
      handoffId: string;
      force: boolean | undefined;
      projectId: string | undefined;
      deleteBranch: boolean | undefined;
    }[] = [];
    stubTeardownWorktree(svc, (handoffId, force, projectId, deleteBranch) => {
      teardownCalls.push({ handoffId, force, projectId, deleteBranch });
      return Promise.resolve({ worktreeRemoved: true, branchDeleted: true });
    });

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-wt-1",
          commit_message: "feat: worktree teardown test",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-wt-1\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.worktree_torn_down).toBe(true);
    expect(body.result.branch_deleted).toBe(true);
    expect(teardownCalls).toEqual([
      { handoffId: "h-wt-1", force: false, projectId: undefined, deleteBranch: false },
    ]);
  });

  test("successful land stamps passed gate_outcome lane-independently when no lane was ever opened", async () => {
    // Pins F1: stampPassedGateOutcome fires for a clean land even when there
    // is no open or closed lane for this handoff. The lane gate is one source
    // of gate_outcome; dispatch-land is the other (rolls forward a clean,
    // non-failed verdict). Do NOT collapse these — the force/audit-accept
    // branch intentionally stays NULL (fail-closed: unverified force-lands
    // are never credited as passing).
    const svc = services();
    seedHandoff(svc, "h-no-lane", "c-no-lane");
    writeVerdictEvent(svc, {
      eventId: "v-no-lane",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-no-lane",
      conversationId: "c-no-lane",
      typecheck: "pass",
      tests: "pass",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-no-lane",
          commit_message: "feat: no-lane land",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-no-lane\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");

    const openLanes = svc.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM lane_ledger WHERE implementer_handoff = ?`)
      .get("h-no-lane");
    expect(openLanes?.n).toBe(0);

    const perf = svc.db
      .query<
        { outcome: string; gate_outcome: string | null },
        [string]
      >(`SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-no-lane");
    expect(perf).toEqual({ outcome: "merged", gate_outcome: "passed" });
  });

  test("successful land stamps passed gate_outcome when the lane is still open", async () => {
    const svc = services();
    seedHandoff(svc, "h-open-lane", "c-open-lane");
    insertLane(svc.db, {
      lane_id: "lane-open-land",
      ts_opened: "2026-05-08T00:00:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "h-open-lane",
    });
    writeVerdictEvent(svc, {
      eventId: "v-open-lane",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-open-lane",
      conversationId: "c-open-lane",
      typecheck: "pass",
      tests: "pass",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-open-lane",
          commit_message: "feat: open lane land",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-open-lane\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");

    const perf = svc.db
      .query<
        { outcome: string; gate_outcome: string | null },
        [string]
      >(`SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-open-lane");
    expect(perf).toEqual({ outcome: "merged", gate_outcome: "passed" });
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

    stubTeardownWorktree(svc, () => Promise.reject(new Error("simulated teardown failure")));

    const warnCalls: unknown[][] = [];
    stubLogWarn(svc, (...args) => {
      warnCalls.push(args);
    });

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-wt-2",
          commit_message: "feat: teardown failure should not block land",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-wt-2\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
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

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: false, branchDeleted: false }),
    );

    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-wt-3",
          commit_message: "feat: truthful teardown flag",
          mode: "squash",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-wt-3\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-5",
          commit_message: "feat: no pr",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "same-main\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
            return { code: 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: (input: { number: number }) => {
            closed.push(input.number);
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result.pr_closed).toBe(false);
    expect(closed).toEqual([]);
  });

  test("gh mode fails closed when no open PR exists for the branch", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-no-pr", "c-gh-no-pr");
    writeVerdictEvent(svc, {
      eventId: "v-gh-no-pr",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-no-pr",
      conversationId: "c-gh-no-pr",
      typecheck: "pass",
      tests: "pass",
    });

    const merged: number[] = [];
    const gitCalls: string[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-no-pr",
          commit_message: "feat: gh no pr",
          mode: "gh",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          gitCalls.push(args.join(" "));
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-no-pr")
            return { code: 0, stdout: "local-sha\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-no-pr")
            return { code: 0, stdout: "local-sha\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          mergePullRequest: (input: { number: number }) => {
            merged.push(input.number);
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error!.code).toBe("no_open_pr_for_branch");
    expect(body.error!.branch).toBe("agent/h-gh-no-pr");
    expect(merged).toEqual([]);
    expect(gitCalls).not.toContain("rev-parse main");
  });

  test("gh mode fails closed when local branch head != remote head", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-stale", "c-gh-stale");
    writeVerdictEvent(svc, {
      eventId: "v-gh-stale",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-stale",
      conversationId: "c-gh-stale",
      typecheck: "pass",
      tests: "pass",
    });

    const merged: number[] = [];
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-stale",
          commit_message: "feat: gh stale branch",
          mode: "gh",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-stale")
            return { code: 0, stdout: "9111b73d\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-stale")
            return { code: 0, stdout: "4a114160\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 55 }],
          mergePullRequest: (input: { number: number }) => {
            merged.push(input.number);
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error!.code).toBe("branch_not_pushed");
    expect(body.error!.local_sha).toBe("9111b73d");
    expect(body.error!.remote_sha).toBe("4a114160");
    expect(merged).toEqual([]);
  });

  test("gh mode happy path: merges PR, does NOT close it, stamps performance, tears down worktree", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-ok", "c-gh-ok");
    writeVerdictEvent(svc, {
      eventId: "v-gh-ok",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-ok",
      conversationId: "c-gh-ok",
      typecheck: "pass",
      tests: "pass",
    });
    seedAgentPerformanceRow(svc, {
      performanceId: "perf-gh-ok",
      ts: "2026-05-08T00:01:30.000Z",
      handoffId: "h-gh-ok",
      conversationId: "c-gh-ok",
      projectId: null,
      agentName: "codex",
      taskType: "implement_small",
      outcome: "no_changes",
    });

    const merged: GhMergePullRequestInput[] = [];
    const closed: number[] = [];
    let mainRevParseCount = 0;
    const getPrCalls: number[] = [];
    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-ok",
          commit_message: "feat(core): gh merge happy path",
          mode: "gh",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-ok")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-ok")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "main") {
            mainRevParseCount += 1;
            return { code: 0, stdout: "stale-local-main-sha\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 123 }],
          closePullRequest: (input: { number: number }) => {
            closed.push(input.number);
          },
          mergePullRequest: (input: GhMergePullRequestInput) => {
            merged.push(input);
          },
          getPullRequest: (prNumber: number): GhPullRequestView => {
            getPrCalls.push(prNumber);
            return { number: prNumber, state: "MERGED", mergeCommitOid: "gh-merge-oid-abc123" };
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      commit_sha: "gh-merge-oid-abc123",
      message_subject: "feat(core): gh merge happy path",
      branch_deleted: true,
      worktree_torn_down: true,
      pr_closed: false,
      pr_merged: true,
      pr_number: 123,
    });
    expect(merged).toEqual([
      {
        number: 123,
        method: "squash",
        subject: "feat(core): gh merge happy path",
        body: "feat(core): gh merge happy path",
        deleteBranch: false,
      },
    ]);
    expect(closed).toEqual([]);
    expect(mainRevParseCount).toBe(0);
    expect(getPrCalls).toEqual([123]);

    const perf = svc.db
      .query<
        { outcome: string; gate_outcome: string | null },
        [string]
      >(`SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-gh-ok");
    expect(perf).toEqual({ outcome: "merged", gate_outcome: "passed" });

    const landed = svc.db
      .query<
        { event_type: string; payload_json: string },
        []
      >(`SELECT event_type, payload_json FROM t0_events WHERE event_type='dispatch.landed' ORDER BY ts DESC LIMIT 1`)
      .get();
    expect(landed?.event_type).toBe("dispatch.landed");
    const payload = JSON.parse(landed?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      handoff_id: "h-gh-ok",
      mode: "gh",
      commit_sha: "gh-merge-oid-abc123",
    });
  });

  test("gh mode fails closed when PR reads back state OPEN (merge-queue case): no performance stamp, no worktree teardown", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-queued", "c-gh-queued");
    writeVerdictEvent(svc, {
      eventId: "v-gh-queued",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-queued",
      conversationId: "c-gh-queued",
      typecheck: "pass",
      tests: "pass",
    });
    seedAgentPerformanceRow(svc, {
      performanceId: "perf-gh-queued",
      ts: "2026-05-08T00:01:30.000Z",
      handoffId: "h-gh-queued",
      conversationId: "c-gh-queued",
      projectId: null,
      agentName: "codex",
      taskType: "implement_small",
      outcome: "no_changes",
    });

    let teardownCalled = false;
    stubTeardownWorktree(svc, () => {
      teardownCalled = true;
      return Promise.resolve({ worktreeRemoved: true, branchDeleted: true });
    });
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-queued",
          commit_message: "feat(core): gh merge queued",
          mode: "gh",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-queued")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-queued")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 200 }],
          mergePullRequest: () => {
            /* gh pr merge exits 0 but PR is enqueued, not merged */
          },
          getPullRequest: (prNumber: number): GhPullRequestView => ({
            number: prNumber,
            state: "OPEN",
            mergeCommitOid: null,
          }),
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error!.code).toBe("gh_pr_not_merged");
    expect(body.error!.pr_number).toBe(200);
    expect(body.error!.pr_state).toBe("OPEN");
    expect(teardownCalled).toBe(false);

    const perf = svc.db
      .query<
        { outcome: string },
        [string]
      >(`SELECT outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-gh-queued");
    expect(perf?.outcome).toBe("no_changes");

    const landedCount = svc.db
      .query<
        { count: number },
        []
      >(`SELECT COUNT(*) AS count FROM t0_events WHERE event_type='dispatch.landed'`)
      .get();
    expect(landedCount?.count).toBe(0);
  });

  test("gh mode fails closed when PR is MERGED but mergeCommit oid is null", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-null-oid", "c-gh-null-oid");
    writeVerdictEvent(svc, {
      eventId: "v-gh-null-oid",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-null-oid",
      conversationId: "c-gh-null-oid",
      typecheck: "pass",
      tests: "pass",
    });

    let teardownCalled = false;
    stubTeardownWorktree(svc, () => {
      teardownCalled = true;
      return Promise.resolve({ worktreeRemoved: true, branchDeleted: true });
    });
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-null-oid",
          commit_message: "feat(core): gh null oid",
          mode: "gh",
          delete_branch: true,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-null-oid")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-null-oid")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 201 }],
          mergePullRequest: () => {
            /* no-op */
          },
          getPullRequest: (prNumber: number): GhPullRequestView => ({
            number: prNumber,
            state: "MERGED",
            mergeCommitOid: null,
          }),
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("failed");
    expect(body.error!.code).toBe("gh_pr_not_merged");
    expect(body.error!.pr_state).toBe("MERGED");
    expect(teardownCalled).toBe(false);
  });

  test("gh mode returns the GitHub mergeCommit oid as commit_sha, NOT the stale local main sha", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-oid-vs-main", "c-gh-oid-vs-main");
    writeVerdictEvent(svc, {
      eventId: "v-gh-oid-vs-main",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-oid-vs-main",
      conversationId: "c-gh-oid-vs-main",
      typecheck: "pass",
      tests: "pass",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-oid-vs-main",
          commit_message: "feat(core): oid not main",
          mode: "gh",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-oid-vs-main")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-oid-vs-main")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          // Local main sha is deliberately DIFFERENT from the GitHub merge oid.
          if (args[0] === "rev-parse" && args[1] === "main")
            return { code: 0, stdout: "stale-local-main-sha\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 300 }],
          mergePullRequest: () => {
            /* no-op */
          },
          getPullRequest: (prNumber: number): GhPullRequestView => ({
            number: prNumber,
            state: "MERGED",
            mergeCommitOid: "authoritative-gh-merge-oid",
          }),
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result!.commit_sha).toBe("authoritative-gh-merge-oid");
    expect(body.result!.commit_sha).not.toBe("stale-local-main-sha");
  });

  test("gh mode already_landed resolves to the correct merge commit oid from GitHub", async () => {
    const svc = services();
    seedHandoff(svc, "h-gh-already", "c-gh-already");
    writeVerdictEvent(svc, {
      eventId: "v-gh-already",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-gh-already",
      conversationId: "c-gh-already",
      typecheck: "pass",
      tests: "pass",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );
    const res = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-gh-already",
          commit_message: "feat(core): already merged",
          mode: "gh",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "agent/h-gh-already")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          if (args[0] === "fetch" && args[1] === "origin")
            return { code: 0, stdout: "", stderr: "" };
          if (args[0] === "rev-parse" && args[1] === "origin/agent/h-gh-already")
            return { code: 0, stdout: "branch-head\n", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [{ number: 301 }],
          mergePullRequest: () => {
            throw new Error("Pull request already been merged");
          },
          getPullRequest: (prNumber: number): GhPullRequestView => ({
            number: prNumber,
            state: "MERGED",
            mergeCommitOid: "already-merged-oid-999",
          }),
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );

    expect(res.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(res);
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      commit_sha: "already-merged-oid-999",
      already_landed: true,
      pr_merged: false,
      pr_number: 301,
    });

    const landedCount = svc.db
      .query<
        { count: number },
        []
      >(`SELECT COUNT(*) AS count FROM t0_events WHERE event_type='dispatch.landed'`)
      .get();
    expect(landedCount?.count).toBe(0);
  });

  test("gh mode squash and ff modes are unchanged (regression guard)", async () => {
    const svc = services();
    seedHandoff(svc, "h-regress-squash", "c-regress-squash");
    seedHandoff(svc, "h-regress-ff", "c-regress-ff");
    writeVerdictEvent(svc, {
      eventId: "v-regress-squash",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-regress-squash",
      conversationId: "c-regress-squash",
      typecheck: "pass",
      tests: "pass",
    });
    writeVerdictEvent(svc, {
      eventId: "v-regress-ff",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-regress-ff",
      conversationId: "c-regress-ff",
      typecheck: "pass",
      tests: "pass",
    });

    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );

    const squashCalls: string[] = [];
    let squashRevParse = 0;
    const squashRes = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-regress-squash",
          commit_message: "feat: regression squash",
          mode: "squash",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          squashCalls.push(args.join(" "));
          if (args[0] === "rev-parse" && args[1] === "main") {
            squashRevParse += 1;
            return {
              code: 0,
              stdout: squashRevParse === 1 ? "sq-before\n" : "sq-after\n",
              stderr: "",
            };
          }
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet")
            return { code: 1, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );
    const squashAccepted = await readJsonAs<AcceptedBody>(squashRes);
    const squashBody = await waitForLandTask(svc, squashAccepted.task_id);
    expect(squashBody.status).toBe("done");
    expect(squashBody.result!.commit_sha).toBe("sq-after");
    expect(squashBody.result!.pr_merged).toBeUndefined();
    expect(squashCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --squash agent/h-regress-squash",
      "diff --cached --quiet",
      "commit -F -",
      "rev-parse main",
    ]);

    const ffCalls: string[] = [];
    let ffRevParse = 0;
    const ffRes = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-regress-ff",
          commit_message: "feat: regression ff",
          mode: "ff",
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          ffCalls.push(args.join(" "));
          if (args[0] === "rev-parse" && args[1] === "main") {
            ffRevParse += 1;
            return {
              code: 0,
              stdout: ffRevParse === 1 ? "ff-before\n" : "ff-after\n",
              stderr: "",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );
    const ffAccepted = await readJsonAs<AcceptedBody>(ffRes);
    const ffBody = await waitForLandTask(svc, ffAccepted.task_id);
    expect(ffBody.status).toBe("done");
    expect(ffBody.result!.commit_sha).toBe("ff-after");
    expect(ffBody.result!.pr_merged).toBeUndefined();
    expect(ffCalls).toEqual([
      "rev-parse main",
      "status --porcelain --untracked-files=no",
      "checkout main",
      "merge --ff-only agent/h-regress-ff",
      "rev-parse main",
    ]);
  });
});

describe("dispatchLandTasks eviction", () => {
  beforeEach(() => {
    // Other test cases in this file accumulate terminal entries in the
    // module-scoped Map; clear it so eviction assertions are deterministic.
    __dispatchLandInternalsForTest.tasks.clear();
  });

  function seedTerminalEntry(
    taskId: string,
    handoffId: string,
    status: "done" | "failed",
    finishedAtIso: string,
  ): void {
    __dispatchLandInternalsForTest.tasks.set(taskId, {
      task_id: taskId,
      handoff_id: handoffId,
      status,
      created_at: finishedAtIso,
      started_at: finishedAtIso,
      finished_at: finishedAtIso,
      result:
        status === "done"
          ? {
              ok: true as const,
              commit_sha: "fake",
              message_subject: "",
              branch_deleted: false,
              pr_closed: false,
              worktree_torn_down: false,
            }
          : null,
      error: status === "failed" ? { code: "fake" } : null,
    });
  }

  function seedInFlightEntry(
    taskId: string,
    handoffId: string,
    status: "queued" | "running",
  ): void {
    __dispatchLandInternalsForTest.tasks.set(taskId, {
      task_id: taskId,
      handoff_id: handoffId,
      status,
      created_at: "2026-05-08T00:00:00.000Z",
      started_at: status === "running" ? "2026-05-08T00:00:01.000Z" : null,
      finished_at: null,
      result: null,
      error: null,
    });
  }

  test("evicts terminal entries past TTL but keeps in-flight and recent terminals", () => {
    // Stale terminals — both done and failed older than 1h.
    const staleIds = ["evict-ttl-stale-1", "evict-ttl-stale-2", "evict-ttl-stale-3"];
    for (const id of staleIds) {
      seedTerminalEntry(
        id,
        `h-${id}`,
        id.endsWith("3") ? "failed" : "done",
        "2026-05-07T23:50:00.000Z", // 1h10m before "now" — strictly past 1h TTL
      );
    }
    // Fresh terminal — finished 5 minutes before "now"; must survive TTL.
    seedTerminalEntry("evict-ttl-fresh", "h-evict-ttl-fresh", "done", "2026-05-08T00:55:00.000Z");
    // In-flight entries — must survive regardless of age.
    seedInFlightEntry("evict-ttl-queued", "h-evict-ttl-queued", "queued");
    seedInFlightEntry("evict-ttl-running", "h-evict-ttl-running", "running");

    __dispatchLandInternalsForTest.evict({
      now: new Date("2026-05-08T01:00:00.000Z"),
      ttlMs: 60 * 60 * 1000,
      maxSize: 10_000, // disable capacity cap for this case
    });

    for (const id of staleIds) {
      expect(__dispatchLandInternalsForTest.tasks.has(id), `${id} should be evicted`).toBe(false);
    }
    expect(__dispatchLandInternalsForTest.tasks.has("evict-ttl-fresh")).toBe(true);
    expect(__dispatchLandInternalsForTest.tasks.has("evict-ttl-queued")).toBe(true);
    expect(__dispatchLandInternalsForTest.tasks.has("evict-ttl-running")).toBe(true);
  });

  test("capacity cap evicts oldest terminals first while in-flight survive", () => {
    const baseMs = Date.parse("2026-05-08T00:30:00.000Z");
    // Seed 20 terminal entries with monotonically increasing finished_at —
    // all fresh enough that TTL would not evict at the chosen "now".
    const terminalIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = `evict-cap-term-${i.toString().padStart(2, "0")}`;
      const finishedAt = new Date(baseMs + i * 1000).toISOString();
      seedTerminalEntry(id, `h-${id}`, i % 2 === 0 ? "done" : "failed", finishedAt);
      terminalIds.push(id);
    }
    // Two in-flight tasks: must NOT be evicted even when over cap.
    seedInFlightEntry("evict-cap-queued", "h-evict-cap-queued", "queued");
    seedInFlightEntry("evict-cap-running", "h-evict-cap-running", "running");

    expect(__dispatchLandInternalsForTest.tasks.size).toBe(22);

    // Cap=12 forces eviction of 10 terminals (22 -> 12).
    __dispatchLandInternalsForTest.evict({
      now: new Date("2026-05-08T00:31:00.000Z"),
      ttlMs: 60 * 60 * 1000,
      maxSize: 12,
    });

    expect(__dispatchLandInternalsForTest.tasks.size).toBe(12);
    // In-flight survives.
    expect(__dispatchLandInternalsForTest.tasks.has("evict-cap-queued")).toBe(true);
    expect(__dispatchLandInternalsForTest.tasks.has("evict-cap-running")).toBe(true);
    // Oldest 10 terminals evicted; newest 10 survive.
    for (let i = 0; i < 10; i += 1) {
      expect(
        __dispatchLandInternalsForTest.tasks.has(terminalIds[i]!),
        `${terminalIds[i]!} evicted`,
      ).toBe(false);
    }
    for (let i = 10; i < 20; i += 1) {
      expect(
        __dispatchLandInternalsForTest.tasks.has(terminalIds[i]!),
        `${terminalIds[i]!} kept`,
      ).toBe(true);
    }
  });

  test("capacity cap will not evict in-flight even if it cannot reach maxSize", () => {
    // 15 in-flight, 0 terminal — cap is impossible to honour without evicting in-flight.
    for (let i = 0; i < 15; i += 1) {
      const id = `evict-overflow-${i.toString().padStart(2, "0")}`;
      seedInFlightEntry(id, `h-${id}`, i % 2 === 0 ? "queued" : "running");
    }
    expect(__dispatchLandInternalsForTest.tasks.size).toBe(15);

    __dispatchLandInternalsForTest.evict({
      now: new Date("2026-05-08T01:00:00.000Z"),
      ttlMs: 60 * 60 * 1000,
      maxSize: 5,
    });

    // Map stays at 15 — in-flight survives by design even when over cap.
    expect(__dispatchLandInternalsForTest.tasks.size).toBe(15);
  });

  test("eviction is a no-op when under cap and within TTL", () => {
    const freshTs = "2026-05-08T00:59:30.000Z";
    const ids = ["evict-noop-1", "evict-noop-2", "evict-noop-3", "evict-noop-queued"];
    for (let i = 0; i < 3; i += 1) {
      const id = ids[i]!;
      seedTerminalEntry(id, `h-${id}`, "done", freshTs);
    }
    seedInFlightEntry("evict-noop-queued", "h-evict-noop-queued", "queued");

    const before = __dispatchLandInternalsForTest.tasks.size;
    __dispatchLandInternalsForTest.evict({
      now: new Date("2026-05-08T01:00:00.000Z"),
      ttlMs: 60 * 60 * 1000,
      maxSize: 10_000,
    });

    expect(__dispatchLandInternalsForTest.tasks.size).toBe(before);
    for (const id of ids) expect(__dispatchLandInternalsForTest.tasks.has(id)).toBe(true);
  });
});

describe("dispatchLandRoute response schema pins", () => {
  test("202 accepted response safeParses DispatchLandAcceptedSchema", async () => {
    const svc = services();
    seedHandoff(svc, "h-schema-202", "c-schema-202");
    writeVerdictEvent(svc, {
      eventId: "v-schema-202",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-schema-202",
      conversationId: "c-schema-202",
      typecheck: "pass",
      tests: "pass",
    });

    const post = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-schema-202",
          commit_message: "feat(core): schema pin",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main")
            return { code: 0, stdout: "m\n", stderr: "" };
          if (args[0] === "merge" && args[1] === "--ff-only")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );
    expect(post.status).toBe(202);
    const body = await post.json();
    expect(DispatchLandAcceptedSchema.safeParse(body).success).toBe(true);
  });

  test("task GET response safeParses DispatchLandTaskSchema", async () => {
    const svc = services();
    seedHandoff(svc, "h-schema-task", "c-schema-task");
    writeVerdictEvent(svc, {
      eventId: "v-schema-task",
      ts: "2026-05-08T00:01:00.000Z",
      handoffId: "h-schema-task",
      conversationId: "c-schema-task",
      typecheck: "pass",
      tests: "pass",
    });

    const post = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-schema-task",
          commit_message: "feat(core): task schema pin",
          mode: "ff",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        runGit: (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "main") {
            return { code: 0, stdout: "m\n", stderr: "" };
          }
          if (args[0] === "merge" && args[1] === "--ff-only")
            return { code: 0, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        gh: {
          listOpenPullRequestsByHead: () => [],
          closePullRequest: () => {
            /* no-op */
          },
        },
        now: () => new Date("2026-05-08T00:04:00.000Z"),
      }),
    );
    expect(post.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(post);
    await waitForLandTask(svc, accepted.task_id);

    const taskRes = dispatchLandTaskRoute(
      new Request(`http://x/dispatch/land/${accepted.task_id}`),
      svc,
      accepted.task_id,
    );
    expect(taskRes.status).toBe(200);
    const taskBody = await taskRes.json();
    expect(DispatchLandTaskSchema.safeParse(taskBody).success).toBe(true);
  });
});

test("POST /dispatch/land rejects rebase with invalid_params", async () => {
  const response = await dispatchLandRoute(
    landReq("http://x/dispatch/land", {
      method: "POST",
      body: JSON.stringify({ handoff_id: "h-invalid-mode", mode: "rebase" }),
    }),
    services(),
  );
  expect(response.status).toBe(400);
  const body = await readJsonAs<{ error: { code: string } }>(response);
  expect(body.error.code).toBe("invalid_params");
});

test("sweep -> land -> supersede -> reconciler re-capture preserves the real verdict", async () => {
  const svc = services();
  try {
    seedHandoff(svc, "h-f2-lifecycle", "c-f2-lifecycle");
    seedHandoff(svc, "h-f2-review", "c-f2-review");
    svc.db.run(
      "UPDATE handoffs SET status='completed', resolved_at='2026-05-08T00:00:00.000Z' WHERE handoff_id='h-f2-lifecycle'",
    );
    svc.db.run(
      "UPDATE handoffs SET to_agent='independent-reviewer' WHERE handoff_id='h-f2-review'",
    );
    insertLane(svc.db, {
      lane_id: "lane-f2-lifecycle",
      ts_opened: "2026-05-08T00:00:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "h-f2-lifecycle",
    });
    const sweepTime = "2026-05-09T01:00:00.000Z";
    expect(runOrphanLanesSweep(svc, { nowIso: sweepTime }).closed).toBe(1);
    writeVerdictEvent(svc, {
      eventId: "v-f2-lifecycle",
      ts: "2026-05-09T01:01:00.000Z",
      handoffId: "h-f2-lifecycle",
      conversationId: "c-f2-lifecycle",
      typecheck: "pass",
      tests: "pass",
    });
    stubTeardownWorktree(svc, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: false }),
    );
    const land = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-f2-lifecycle",
          commit_message: "fix(core): record reviewed verdict",
          mode: "squash",
          delete_branch: false,
        }),
      }),
      svc,
      landDeps({
        now: () => new Date("2026-05-09T01:02:00.000Z"),
        runGit: (args) => {
          if (args[0] === "rev-parse") return { code: 0, stdout: "sha-f2-lifecycle\n", stderr: "" };
          if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet")
            return { code: 1, stdout: "", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );
    expect(land.status).toBe(202);
    const accepted = await readJsonAs<AcceptedBody>(land);
    expect((await waitForLandTask(svc, accepted.task_id)).status).toBe("done");
    const perf = (): unknown =>
      svc.db
        .query(
          "SELECT outcome, gate_outcome FROM agent_performance WHERE handoff_id='h-f2-lifecycle'",
        )
        .get();
    expect(perf()).toEqual({ outcome: "merged", gate_outcome: "review_debt" });
    insertLane(svc.db, {
      lane_id: "later-swept-duplicate",
      ts_opened: sweepTime,
      ts_closed: "2026-05-09T01:03:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "h-f2-lifecycle",
      gate_status: "review_debt",
      override_reason: getLane(svc.db, "lane-f2-lifecycle")!.override_reason,
    });
    svc.clock = (): Date => new Date("2026-05-09T01:04:00.000Z");
    const close = await lanesCloseRoute(
      new Request("http://x/lanes/close", {
        method: "POST",
        body: JSON.stringify({
          lane_id: "lane-f2-lifecycle",
          gate_status: "passed",
          reviewer_handoff: "h-f2-review",
        }),
      }),
      svc,
    );
    expect(close.status).toBe(200);
    expect(await close.json()).toMatchObject({
      superseded: { gate_status: "review_debt", ts_closed: sweepTime },
    });
    expect(perf()).toEqual({ outcome: "merged", gate_outcome: "passed" });
    const recapture = (): ReturnType<typeof captureAgentPerformanceFromReconciler> =>
      captureAgentPerformanceFromReconciler({
        db: svc.db,
        uuid: svc.uuid,
        clock: svc.clock,
        input: { handoff_id: "h-f2-lifecycle", result: { status: "merged" } },
      });
    expect(recapture().gate_outcome).toBe("passed");
    svc.db.run("DELETE FROM agent_performance WHERE handoff_id='h-f2-lifecycle'");
    expect(recapture().gate_outcome).toBe("passed");
    expect(perf()).toEqual({ outcome: "merged", gate_outcome: "passed" });
  } finally {
    svc.supervisor.stopAll();
    svc.db.close();
  }
});
