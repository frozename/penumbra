import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorktreeManager } from "@penumbra/core";
import { createMergeReconciler } from "../../src/worker/merge-reconciler.js";

const execHistory: string[] = [];
let diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
let nextExecResult = { stdout: "", stderr: "" };
let execFailures: Record<string, any> = {};
const warnCalls: any[] = [];
const infoCalls: any[] = [];
const errorCalls: any[] = [];
let worktreePath = process.cwd();

const mockDeps: any = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock(async () => {}),
  notifyResult: mock(async () => {}),
  captureResult: mock(async () => {}),
  emitVerdict: mock(async () => {}),
  log: {
    info: mock((payload: any, msg?: string) => {
      infoCalls.push({ payload, msg });
    }),
    debug: mock(() => {}),
    error: mock((payload: any, msg?: string) => {
      errorCalls.push({ payload, msg });
    }),
    warn: mock((payload: any, msg?: string) => {
      warnCalls.push({ payload, msg });
    }),
  },
  mainRepoDir: process.cwd(),
  getHandoff: mock(async () => ({
    handoff_id: "h1",
    ts: "2026-05-12T00:00:00.000Z",
    project_id: null,
    conversation_id: "c-123",
    from_agent: "user",
    to_agent: "codex",
    to_role: null,
    message: "scope typecheck",
    status: "completed",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    open_pr_on_review: 0,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  })),
  createDispatchPR: mock(async () => ({
    url: "https://github.com/acordeiro/penumbra/pull/1",
    number: 1,
  })),
  exec: mock(async (argv: string[]) => {
    const cmd = argv.join(" ");
    execHistory.push(cmd);
    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) throw error;
    }
    if (cmd.startsWith("git diff --name-only")) {
      return { stdout: diffOutput, stderr: "" };
    }
    return nextExecResult;
  }),
  settings: {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  },
};

spyOn(WorktreeManager.prototype, "getWorktree").mockImplementation((id: string) => {
  return {
    handoffId: id,
    path: worktreePath,
    branchName: `agent/${id}`,
    storageRoot: `${worktreePath}/.test-storage`,
    createdAt: "",
    status: "created",
  } as any;
});

beforeEach(() => {
  execHistory.length = 0;
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  nextExecResult = { stdout: "", stderr: "" };
  execFailures = {};
  warnCalls.length = 0;
  infoCalls.length = 0;
  errorCalls.length = 0;
  worktreePath = process.cwd();
});

function makeReconciler() {
  return createMergeReconciler(mockDeps);
}

test("clean post-merge typecheck passes", async () => {
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("verified");
  expect(execHistory.some((cmd) => cmd.startsWith("bun tsc -b packages/core"))).toBe(true);
  expect(warnCalls).toHaveLength(0);
});

test("pre-existing typecheck errors outside the diff do not fail reconciliation", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures["bun tsc -b"] = {
    stdout: "",
    stderr:
      'packages/core/src/index.ts(1,1): error TS2304: Cannot find name "Foo".\n' +
      'packages/core/src/index.ts(2,3): error TS2322: Type "string" is not assignable to type "number".\n',
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("verified");
  expect(execHistory.some((cmd) => cmd.startsWith("bun tsc -b packages/core"))).toBe(true);
  expect(warnCalls).toHaveLength(1);
  expect(warnCalls[0]).toMatchObject({
    payload: expect.objectContaining({
      component: "reconciler-typecheck-baseline-filter",
      handoff_id: "h1",
      pre_existing_error_count: 2,
    }),
  });
  expect(
    infoCalls.some((call) => call.msg === "reconciliation complete — verified without PR"),
  ).toBe(true);
});

test("mixed typecheck failures only attribute changed-file errors", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures["packages/daemon"] = {
    stdout: "",
    stderr:
      'packages/daemon/src/routes/handoffs.ts(12,5): error TS2345: Argument of type "string" is not assignable to parameter of type "number".\n' +
      'packages/core/src/index.ts(1,1): error TS2304: Cannot find name "Foo".\n',
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:12:5 TS2345");
  expect(result.regression_summary).not.toContain("packages/core/src/index.ts");
});

test("typecheck failures in unchanged files within the changed package still fail reconciliation", async () => {
  diffOutput = "packages/agentchat/src/worker/merge-reconciler.ts\n";
  execFailures["bun tsc -b packages/core packages/agentchat"] = {
    stdout: "",
    stderr:
      'packages/agentchat/src/worker/merge-reconciler-sibling.ts(4,7): error TS2322: Type "number" is not assignable to type "string".\n',
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain(
    "packages/agentchat/src/worker/merge-reconciler-sibling.ts:4:7 TS2322",
  );
});

test("typecheck failures in reverse-dependent workspace packages still fail reconciliation", async () => {
  diffOutput = "packages/core/src/index.ts\n";
  execFailures["packages/daemon"] = {
    stdout: "",
    stderr:
      'packages/daemon/src/routes/handoffs.ts(18,9): error TS2339: Property "foo" does not exist on type "Bar".\n',
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:18:9 TS2339");
});

test("mixed typecheck failures include direct and closure hits but exclude pre-existing errors", async () => {
  diffOutput = "packages/agentchat/src/worker/merge-reconciler.ts\n";
  execFailures["packages/daemon"] = {
    stdout: "",
    stderr:
      'packages/agentchat/src/worker/merge-reconciler.ts(12,5): error TS2345: Argument of type "string" is not assignable to parameter of type "number".\n' +
      'packages/daemon/src/routes/handoffs.ts(18,9): error TS2339: Property "foo" does not exist on type "Bar".\n' +
      'packages/workflows/src/schema.ts(7,3): error TS2322: Type "boolean" is not assignable to type "string".\n',
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain(
    "packages/agentchat/src/worker/merge-reconciler.ts:12:5 TS2345",
  );
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:18:9 TS2339");
  expect(result.regression_summary).not.toContain("packages/workflows/src/schema.ts");
});

test("parse failures fall back to raw typecheck output", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n";
  execFailures["bun tsc -b"] = {
    stdout: "",
    stderr: "this is not a ts error line\n",
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("this is not a ts error line");
  expect(
    warnCalls.some((call) => call.payload?.component === "reconciler-typecheck-parse-fallback"),
  ).toBe(true);
});

test("full-tree fallback attributes any package diagnostic", async () => {
  diffOutput = "packages/daemon/src/routes/handoffs.ts\n../scripts/tool.ts\n";
  execFailures["bun run typecheck"] = {
    stdout: "",
    stderr:
      'packages/core/src/index.ts(1,1): error TS2304: Cannot find name "Foo".\n' +
      'packages/daemon/src/routes/handoffs.ts(9,2): error TS2339: Property "x" does not exist on type "never".\n',
  };
  const reconciler = makeReconciler();

  const result = await reconciler("h1");

  expect(result.status).toBe("typecheck_failed");
  expect(result.regression_summary).toContain("packages/core/src/index.ts:1:1 TS2304");
  expect(result.regression_summary).toContain("packages/daemon/src/routes/handoffs.ts:9:2 TS2339");
});

test("includes malformed workspace packages in the scoped build set and logs an error", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "merge-reconciler-worktree-"));
  worktreePath = tmpRoot;
  fs.mkdirSync(path.join(tmpRoot, "packages", "daemon", "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "packages", "brokenpkg"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "packages", "daemon", "package.json"),
    JSON.stringify({
      name: "@penumbra/daemon",
      dependencies: { "@penumbra/brokenpkg": "workspace:*" },
    }),
  );
  fs.writeFileSync(path.join(tmpRoot, "packages", "brokenpkg", "package.json"), "{");

  const reconciler = makeReconciler();

  await reconciler("h1");

  expect(execHistory).toContain("bun tsc -b packages/core packages/brokenpkg packages/daemon");
  expect(
    errorCalls.some((call) =>
      String(call.msg).includes("workspace package manifest missing or invalid"),
    ),
  ).toBe(true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
