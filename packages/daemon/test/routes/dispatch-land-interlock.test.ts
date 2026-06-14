import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import {
  dispatchLandRoute,
  dispatchLandTaskRoute,
  type DispatchLandDeps,
} from "../../src/routes/dispatch-land.js";
import { lifecycleLock, resetLifecycleLock } from "../../src/dispatch/lifecycle-lock.js";

function services(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-land-interlock-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-08T00:00:00.000Z"),
    uuid: () => `id-${++n}`,
  });
}

function seedHandoff(svc: Services, handoffId: string, conversationId: string): void {
  svc.handoffWriter.createApproved({
    handoff_id: handoffId,
    ts: "2026-05-08T00:00:00.000Z",
    project_id: null,
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

function writePassingVerdict(svc: Services, handoffId: string, conversationId: string): void {
  svc.t0Writer.write({
    event_id: `v-${handoffId}`,
    ts: "2026-05-08T00:01:00.000Z",
    ingest_ts: "2026-05-08T00:01:00.000Z",
    source: "agentchat",
    source_detail: "merge-reconciler",
    project_id: null,
    user_id: "local-user",
    machine_id: "machine-1",
    session_id: conversationId,
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
      handoff_id: handoffId,
      conversation_id: conversationId,
      branch: `agent/${handoffId}`,
      typecheck: "pass",
      tests: "pass",
      files_changed: 1,
      lines_added: 5,
      lines_deleted: 0,
      summary: "pass/pass",
    },
    payload_summary: "pass/pass",
  });
}

const mockGh: DispatchLandDeps["gh"] = {
  listOpenPullRequestsByHead: async () => [],
  closePullRequest: async () => {},
};

const mockNow = () => new Date("2026-05-08T00:04:00.000Z");

function successRunGit(handoffId: string) {
  let revParseCount = 0;
  return async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (args[0] === "log") return { code: 0, stdout: `feat: ${handoffId}\n`, stderr: "" };
    if (args[0] === "rev-parse") {
      revParseCount += 1;
      return {
        code: 0,
        stdout: revParseCount === 1 ? "before-sha\n" : `after-${handoffId}\n`,
        stderr: "",
      };
    }
    if (args[0] === "merge" || args[0] === "checkout" || args[0] === "commit")
      return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function waitForLandTask(svc: Services, taskId: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const res = await dispatchLandTaskRoute(
      new Request(`http://x/dispatch/land/${taskId}`),
      svc,
      taskId,
    );
    const body = (await res.json()) as any;
    if (body.status === "done" || body.status === "failed") return body;
    await Bun.sleep(5);
  }
  throw new Error(`task ${taskId} did not finish`);
}

async function pollUntil(predicate: () => boolean, maxMs = 2000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("pollUntil timed out");
    await Bun.sleep(5);
  }
}

describe("dispatch-land lifecycle interlock", () => {
  test("two concurrent lands for different handoffs serialize git writes (no interleaving)", async () => {
    resetLifecycleLock();
    const svc = services();
    seedHandoff(svc, "h-ser-1", "c-ser-1");
    seedHandoff(svc, "h-ser-2", "c-ser-2");
    writePassingVerdict(svc, "h-ser-1", "c-ser-1");
    writePassingVerdict(svc, "h-ser-2", "c-ser-2");

    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: false,
      branchDeleted: false,
    });

    const gitCallLog: Array<{ handoff: string; args: string[] }> = [];
    const makeRunGit = (handoffId: string): DispatchLandDeps["runGit"] => {
      let revParseCount = 0;
      return async (args) => {
        gitCallLog.push({ handoff: handoffId, args: [...args] });
        if (args[0] === "log") return { code: 0, stdout: `feat: ${handoffId}\n`, stderr: "" };
        if (args[0] === "rev-parse") {
          revParseCount += 1;
          return {
            code: 0,
            stdout: revParseCount === 1 ? "before\n" : `after-${handoffId}\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
    };

    const makeReq = (handoffId: string) =>
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: handoffId,
          commit_message: `feat: ${handoffId}`,
          mode: "ff",
        }),
      });

    const [res1, res2] = await Promise.all([
      dispatchLandRoute(makeReq("h-ser-1"), svc, {
        runGit: makeRunGit("h-ser-1"),
        gh: mockGh,
        now: mockNow,
      }),
      dispatchLandRoute(makeReq("h-ser-2"), svc, {
        runGit: makeRunGit("h-ser-2"),
        gh: mockGh,
        now: mockNow,
      }),
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);
    const b1 = (await res1.json()) as any;
    const b2 = (await res2.json()) as any;

    const [t1, t2] = await Promise.all([
      waitForLandTask(svc, b1.task_id),
      waitForLandTask(svc, b2.task_id),
    ]);
    expect(t1.status).toBe("done");
    expect(t2.status).toBe("done");

    // Verify no interleaving of write-phase git calls between the two lands.
    // Write calls are: rev-parse, checkout/merge/commit.
    // Collect indices of write calls per handoff.
    const writeOps = new Set(["rev-parse", "merge", "checkout", "commit"]);
    const writeLog = gitCallLog.filter((e) => writeOps.has(e.args[0]!));

    const idx1 = writeLog.map((e, i) => (e.handoff === "h-ser-1" ? i : -1)).filter((i) => i >= 0);
    const idx2 = writeLog.map((e, i) => (e.handoff === "h-ser-2" ? i : -1)).filter((i) => i >= 0);

    expect(idx1.length).toBeGreaterThan(0);
    expect(idx2.length).toBeGreaterThan(0);

    // Either all land-1 writes come before all land-2 writes, or vice versa.
    const max1 = Math.max(...idx1);
    const min2 = Math.min(...idx2);
    const max2 = Math.max(...idx2);
    const min1 = Math.min(...idx1);
    const nonInterleaved = max1 < min2 || max2 < min1;
    expect(nonInterleaved).toBe(true);
  });

  test("second land with reject_if_held=true returns lifecycle_busy while lock is held", async () => {
    resetLifecycleLock();
    const svc = services();
    seedHandoff(svc, "h-rej-1", "c-rej-1");
    seedHandoff(svc, "h-rej-2", "c-rej-2");
    writePassingVerdict(svc, "h-rej-1", "c-rej-1");
    writePassingVerdict(svc, "h-rej-2", "c-rej-2");

    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: false,
      branchDeleted: false,
    });

    // latch: holds land-1 inside the git-write section until we release it
    let checkoutWaiting = false;
    let releaseLatch!: () => void;
    const latch = new Promise<void>((resolve) => {
      releaseLatch = resolve;
    });

    let revParseCount = 0;
    const blockingRunGit: DispatchLandDeps["runGit"] = async (args) => {
      if (args[0] === "log") return { code: 0, stdout: "feat: land-1\n", stderr: "" };
      if (args[0] === "rev-parse") {
        revParseCount += 1;
        return { code: 0, stdout: revParseCount === 1 ? "before\n" : "after\n", stderr: "" };
      }
      if (args[0] === "merge" && args[1] === "--ff-only") {
        checkoutWaiting = true;
        await latch;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res1 = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-rej-1",
          commit_message: "feat: lock held",
          mode: "ff",
        }),
      }),
      svc,
      { runGit: blockingRunGit, gh: mockGh, now: mockNow },
    );
    expect(res1.status).toBe(202);
    const b1 = (await res1.json()) as any;

    // Wait until land-1 is inside the lock (merge --ff-only is blocking)
    await pollUntil(() => checkoutWaiting);

    // Lock must be held by h-rej-1
    expect(lifecycleLock.isHeld()).toBe(true);
    expect(lifecycleLock.getHolder()?.handoff_id).toBe("h-rej-1");

    // Second land with reject_if_held=true → immediate lifecycle_busy
    const res2 = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-rej-2",
          commit_message: "feat: should be rejected",
          mode: "ff",
          reject_if_held: true,
        }),
      }),
      svc,
      { runGit: successRunGit("h-rej-2"), gh: mockGh, now: mockNow },
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as any;
    expect(body2.ok).toBe(false);
    expect(body2.error.code).toBe("lifecycle_busy");
    expect(body2.error.holder).toBe("h-rej-1");
    expect(body2.error.retry_after_ms).toBeGreaterThan(0);

    // Release land-1
    releaseLatch();
    const t1 = await waitForLandTask(svc, b1.task_id);
    expect(t1.status).toBe("done");

    // Lock freed after land-1 completes
    await pollUntil(() => !lifecycleLock.isHeld());
    expect(lifecycleLock.isHeld()).toBe(false);
  });

  test("lock released after mid-way throw — no wedge", async () => {
    resetLifecycleLock();
    const svc = services();
    seedHandoff(svc, "h-throw-1", "c-throw-1");
    seedHandoff(svc, "h-throw-2", "c-throw-2");
    writePassingVerdict(svc, "h-throw-1", "c-throw-1");
    writePassingVerdict(svc, "h-throw-2", "c-throw-2");

    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: false,
      branchDeleted: false,
    });

    // First land throws during merge
    const throwingRunGit: DispatchLandDeps["runGit"] = async (args) => {
      if (args[0] === "log") return { code: 0, stdout: "feat: throw-1\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "sha\n", stderr: "" };
      if (args[0] === "merge") throw new Error("simulated git crash mid-merge");
      return { code: 0, stdout: "", stderr: "" };
    };

    const res1 = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-throw-1",
          commit_message: "feat: throw",
          mode: "ff",
        }),
      }),
      svc,
      { runGit: throwingRunGit, gh: mockGh, now: mockNow },
    );
    expect(res1.status).toBe(202);
    const b1 = (await res1.json()) as any;

    const t1 = await waitForLandTask(svc, b1.task_id);
    expect(t1.status).toBe("failed");

    // Lock must be released after the throw
    expect(lifecycleLock.isHeld()).toBe(false);

    // Second land for different handoff succeeds (no wedge)
    const res2 = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-throw-2",
          commit_message: "feat: post-throw",
          mode: "ff",
        }),
      }),
      svc,
      { runGit: successRunGit("h-throw-2"), gh: mockGh, now: mockNow },
    );
    expect(res2.status).toBe(202);
    const b2 = (await res2.json()) as any;
    const t2 = await waitForLandTask(svc, b2.task_id);
    expect(t2.status).toBe("done");
  });

  test("same-handoff retry is idempotent (returns in-flight task_id)", async () => {
    resetLifecycleLock();
    const svc = services();
    seedHandoff(svc, "h-idem-1", "c-idem-1");
    writePassingVerdict(svc, "h-idem-1", "c-idem-1");

    (svc.worktreeManager as any).teardownWorktree = async () => ({
      worktreeRemoved: false,
      branchDeleted: false,
    });

    let mergeWaiting = false;
    let releaseMergeLatch!: () => void;
    const mergeLatch = new Promise<void>((resolve) => {
      releaseMergeLatch = resolve;
    });

    let revParseCount = 0;
    const blockingRunGit: DispatchLandDeps["runGit"] = async (args) => {
      if (args[0] === "log") return { code: 0, stdout: "feat: idem\n", stderr: "" };
      if (args[0] === "rev-parse") {
        revParseCount += 1;
        return { code: 0, stdout: revParseCount === 1 ? "before\n" : "after\n", stderr: "" };
      }
      if (args[0] === "merge" && args[1] === "--ff-only") {
        mergeWaiting = true;
        await mergeLatch;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    // First call
    const res1 = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({ handoff_id: "h-idem-1", commit_message: "feat: idem", mode: "ff" }),
      }),
      svc,
      { runGit: blockingRunGit, gh: mockGh, now: mockNow },
    );
    expect(res1.status).toBe(202);
    const b1 = (await res1.json()) as any;

    // Wait until land-1 is in-flight (merge blocking)
    await pollUntil(() => mergeWaiting);

    // Second call for SAME handoff — should get back the original task_id
    const res2 = await dispatchLandRoute(
      new Request("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({ handoff_id: "h-idem-1", commit_message: "feat: idem retry" }),
      }),
      svc,
      { runGit: successRunGit("h-idem-1"), gh: mockGh, now: mockNow },
    );
    expect(res2.status).toBe(202);
    const b2 = (await res2.json()) as any;
    expect(b2.task_id).toBe(b1.task_id);
    expect(b2.idempotent).toBe(true);

    // Release and verify first task completes
    releaseMergeLatch();
    const t1 = await waitForLandTask(svc, b1.task_id);
    expect(t1.status).toBe("done");
  });
});
