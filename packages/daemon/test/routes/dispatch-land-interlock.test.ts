import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { setPrincipalForTest } from "@src/auth.js";
import { LifecycleLock, lifecycleLock, resetLifecycleLock } from "@src/dispatch/lifecycle-lock.js";
import {
  type DispatchLandDeps,
  dispatchLandRoute,
  dispatchLandTaskRoute,
} from "@src/routes/dispatch-land.js";

// dispatch-land tests bypass the daemon fetch handler, so the auth middleware
// never runs. Stamp a shared principal on each request so the route's
// principal guard does not 403 every existing test.
function landReq(input: string, init?: RequestInit): Request {
  const req = new Request(input, init);
  setPrincipalForTest(req, { kind: "shared", via: "config" });
  return req;
}

// teardownWorktree is a class instance method; tests stub it by reassignment.
type TeardownFn = Services["worktreeManager"]["teardownWorktree"];
function stubTeardownWorktree(svc: Services, impl: TeardownFn): void {
  svc.worktreeManager.teardownWorktree = impl;
}

// File-local typed envelopes for dispatch-land HTTP responses; matches the
// route's emit shapes and what these tests inspect.
interface LandAcceptedBody {
  ok?: boolean;
  task_id: string;
  status: "queued" | "running" | "done" | "failed";
  idempotent?: boolean;
}
interface LandBusyError {
  ok: boolean;
  error: {
    code: string;
    holder: string;
    retry_after_ms: number;
  };
}
interface LandTaskBody {
  task_id: string;
  handoff_id: string;
  status: "queued" | "running" | "done" | "failed";
  result: unknown;
  error: unknown;
}

async function readJsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

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
    uuid: (): string => `id-${String(++n)}`,
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

type GitResult = { code: number; stdout: string; stderr: string };
type RunGitFn = DispatchLandDeps["runGit"];

// teardownWorktree stub: no-op success.
const noopTeardown: TeardownFn = () =>
  Promise.resolve({ worktreeRemoved: false, branchDeleted: false });

const mockGh: DispatchLandDeps["gh"] = {
  listOpenPullRequestsByHead: () => Promise.resolve([]),
  closePullRequest: () => Promise.resolve(),
};

const mockNow = (): Date => new Date("2026-05-08T00:04:00.000Z");

function successRunGit(handoffId: string): RunGitFn {
  let revParseCount = 0;
  return (args: string[]): Promise<GitResult> => {
    if (args[0] === "log")
      return Promise.resolve({ code: 0, stdout: `feat: ${handoffId}\n`, stderr: "" });
    if (args[0] === "rev-parse") {
      revParseCount += 1;
      return Promise.resolve({
        code: 0,
        stdout: revParseCount === 1 ? "before-sha\n" : `after-${handoffId}\n`,
        stderr: "",
      });
    }
    if (args[0] === "merge" || args[0] === "checkout" || args[0] === "commit")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
}

async function waitForLandTask(svc: Services, taskId: string): Promise<LandTaskBody> {
  for (let i = 0; i < 100; i++) {
    const res = dispatchLandTaskRoute(new Request(`http://x/dispatch/land/${taskId}`), svc, taskId);
    const body = await readJsonAs<LandTaskBody>(res);
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

    stubTeardownWorktree(svc, noopTeardown);

    const gitCallLog: { handoff: string; args: string[] }[] = [];
    const makeRunGit = (handoffId: string): RunGitFn => {
      let revParseCount = 0;
      return (args): Promise<GitResult> => {
        gitCallLog.push({ handoff: handoffId, args: [...args] });
        if (args[0] === "log")
          return Promise.resolve({ code: 0, stdout: `feat: ${handoffId}\n`, stderr: "" });
        if (args[0] === "rev-parse") {
          revParseCount += 1;
          return Promise.resolve({
            code: 0,
            stdout: revParseCount === 1 ? "before\n" : `after-${handoffId}\n`,
            stderr: "",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      };
    };

    const makeReq = (handoffId: string): Request =>
      landReq("http://x/dispatch/land", {
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
    const b1 = await readJsonAs<LandAcceptedBody>(res1);
    const b2 = await readJsonAs<LandAcceptedBody>(res2);

    const [t1, t2] = await Promise.all([
      waitForLandTask(svc, b1.task_id),
      waitForLandTask(svc, b2.task_id),
    ]);
    expect(t1.status).toBe("done");
    expect(t2.status).toBe("done");

    // Verify no interleaving of write-phase git calls between the two lands.
    // Write calls are: rev-parse, checkout/merge/commit.
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

    stubTeardownWorktree(svc, noopTeardown);

    // latch: holds land-1 inside the git-write section until we release it
    let checkoutWaiting = false;
    let releaseLatch!: () => void;
    const latch = new Promise<void>((resolve) => {
      releaseLatch = resolve;
    });

    let revParseCount = 0;
    const blockingRunGit: RunGitFn = async (args): Promise<GitResult> => {
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
      landReq("http://x/dispatch/land", {
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
    const b1 = await readJsonAs<LandAcceptedBody>(res1);

    // Wait until land-1 is inside the lock (merge --ff-only is blocking)
    await pollUntil(() => checkoutWaiting);

    // Lock must be held by h-rej-1
    expect(lifecycleLock.isHeld()).toBe(true);
    expect(lifecycleLock.getHolder()?.handoff_id).toBe("h-rej-1");

    // Second land with reject_if_held=true → immediate lifecycle_busy
    const res2 = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
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
    const body2 = await readJsonAs<LandBusyError>(res2);
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

    stubTeardownWorktree(svc, noopTeardown);

    // First land throws during merge
    const throwingRunGit: RunGitFn = (args): Promise<GitResult> => {
      if (args[0] === "log")
        return Promise.resolve({ code: 0, stdout: "feat: throw-1\n", stderr: "" });
      if (args[0] === "rev-parse") return Promise.resolve({ code: 0, stdout: "sha\n", stderr: "" });
      if (args[0] === "merge") throw new Error("simulated git crash mid-merge");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const res1 = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
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
    const b1 = await readJsonAs<LandAcceptedBody>(res1);

    const t1 = await waitForLandTask(svc, b1.task_id);
    expect(t1.status).toBe("failed");

    // Lock must be released after the throw
    expect(lifecycleLock.isHeld()).toBe(false);

    // Second land for different handoff succeeds (no wedge)
    const res2 = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
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
    const b2 = await readJsonAs<LandAcceptedBody>(res2);
    const t2 = await waitForLandTask(svc, b2.task_id);
    expect(t2.status).toBe("done");
  });

  test("same-handoff retry is idempotent (returns in-flight task_id)", async () => {
    resetLifecycleLock();
    const svc = services();
    seedHandoff(svc, "h-idem-1", "c-idem-1");
    writePassingVerdict(svc, "h-idem-1", "c-idem-1");

    stubTeardownWorktree(svc, noopTeardown);

    let mergeWaiting = false;
    let releaseMergeLatch!: () => void;
    const mergeLatch = new Promise<void>((resolve) => {
      releaseMergeLatch = resolve;
    });

    let revParseCount = 0;
    const blockingRunGit: RunGitFn = async (args): Promise<GitResult> => {
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
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({ handoff_id: "h-idem-1", commit_message: "feat: idem", mode: "ff" }),
      }),
      svc,
      { runGit: blockingRunGit, gh: mockGh, now: mockNow },
    );
    expect(res1.status).toBe(202);
    const b1 = await readJsonAs<LandAcceptedBody>(res1);

    // Wait until land-1 is in-flight (merge blocking)
    await pollUntil(() => mergeWaiting);

    // Second call for SAME handoff — should get back the original task_id
    const res2 = await dispatchLandRoute(
      landReq("http://x/dispatch/land", {
        method: "POST",
        body: JSON.stringify({ handoff_id: "h-idem-1", commit_message: "feat: idem retry" }),
      }),
      svc,
      { runGit: successRunGit("h-idem-1"), gh: mockGh, now: mockNow },
    );
    expect(res2.status).toBe(202);
    const b2 = await readJsonAs<LandAcceptedBody>(res2);
    expect(b2.task_id).toBe(b1.task_id);
    expect(b2.idempotent).toBe(true);

    // Release and verify first task completes
    releaseMergeLatch();
    const t1 = await waitForLandTask(svc, b1.task_id);
    expect(t1.status).toBe("done");
  });

  test("stale release from a TTL-evicted holder does not clear the current holder", async () => {
    // Direct unit test: the singleton's 5-min TTL is too long to exercise
    // eviction, so construct a short-TTL instance.
    const lock = new LifecycleLock(40);

    // H0 takes the lock, then its lifecycle op overruns the TTL.
    const releaseH0 = await lock.acquire("h0");
    expect(lock.getHolder()?.handoff_id).toBe("h0");
    await Bun.sleep(60);
    expect(lock.isHeld()).toBe(false); // reclaimIfExpired evicts H0

    // W1 legitimately acquires after the eviction.
    const releaseW1 = await lock.acquire("w1");
    expect(lock.getHolder()?.handoff_id).toBe("w1");

    // H0's finally-block release fires LATE. It must be a no-op — clearing
    // W1's hold here would open a concurrent-land window (two holders, no lock).
    releaseH0();
    expect(lock.isHeld()).toBe(true);
    expect(lock.getHolder()?.handoff_id).toBe("w1");

    // W1's own release still works normally.
    releaseW1();
    expect(lock.isHeld()).toBe(false);
  });

  test("release hands queued waiter ownership before a same-tick acquire can double-grant", async () => {
    const lock = new LifecycleLock(300_000);
    const releaseH0 = await lock.acquire("h0");

    let w1Granted = false;
    const w1Lease = lock.acquire("w1").then((release) => {
      w1Granted = true;
      return release;
    });

    releaseH0();

    let w2Granted = false;
    const w2Lease = lock.acquire("w2").then((release) => {
      w2Granted = true;
      return release;
    });

    expect(lock.getHolder()?.handoff_id).toBe("w1");
    expect(w2Granted).toBe(false);

    const releaseW1 = await w1Lease;
    expect(w1Granted).toBe(true);
    expect(w2Granted).toBe(false);
    expect(lock.getHolder()?.handoff_id).toBe("w1");

    releaseW1();

    const releaseW2 = await w2Lease;
    expect(w2Granted).toBe(true);
    expect(lock.getHolder()?.handoff_id).toBe("w2");

    releaseW2();
    expect(lock.isHeld()).toBe(false);
  });
});
