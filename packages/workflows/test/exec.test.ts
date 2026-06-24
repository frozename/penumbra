import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowCtx } from "../src/ctx.js";
import type { WorkflowSpec } from "../src/schema.js";

import { executeWorkflow } from "../src/exec.js";

test("markdown spec renders body with bundle and writes to file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-"));
  try {
    const spec: WorkflowSpec = {
      name: "demo",
      description: "demo",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [{ kind: "file", path: join(tmp, "out.md") }],
      run: { kind: "markdown-template", template: "# Out\n\n{{recall.git.log}}\n" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: { "git.log": "abc commit msg" }, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.artifacts).toContain(join(tmp, "out.md"));
    expect(readFileSync(join(tmp, "out.md"), "utf8")).toContain("abc commit msg");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ts spec runs fn and surfaces result", async () => {
  const spec: WorkflowSpec = {
    name: "tsdemo",
    description: "tsdemo",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    run: { kind: "ts-function" },
  };
  const fn = (): Promise<{ note: string }> => Promise.resolve({ note: "ran" });
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    fn,
    storageRoot: "/tmp",
  });
  expect(result.outcome).toBe("success");
  expect(result.runResult).toEqual({ note: "ran" });
});

test("ts fn throw → outcome=run_error", async () => {
  const spec: WorkflowSpec = {
    name: "tsdemo2",
    description: "tsdemo2",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    run: { kind: "ts-function" },
  };
  const fn = (): Promise<never> => {
    throw new Error("boom");
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    fn,
    storageRoot: "/tmp",
  });
  expect(result.outcome).toBe("run_error");
  expect(result.errorMessage).toContain("boom");
});

test("ts ctx.fileWrite result is captured as artifact", async () => {
  const spec: WorkflowSpec = {
    name: "ts-write",
    description: "ts-write",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    run: { kind: "ts-function" },
  };

  const ctx: WorkflowCtx = {
    dispatch: () => Promise.resolve({ conversation_id: "conv", handoff_id: "hid" }),
    awaitChain: () =>
      Promise.resolve({
        status: "completed" as const,
        final_agent: "codex",
        response_text: "ok",
      }),
    fileWrite: () => Promise.resolve("/tmp/workflow-out.txt"),
    config: {},
    cwd: "/tmp",
    storageRoot: "/tmp",
    project: "proj",
    args: {},
  };

  const fn = async (workflowCtx: WorkflowCtx): Promise<{ ok: boolean }> => {
    await workflowCtx.fileWrite("ignored.txt", "body");
    return { ok: true };
  };

  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    fn,
    ctx,
    storageRoot: "/tmp",
  });

  expect(result.outcome).toBe("success");
  expect(result.artifacts).toContain("/tmp/workflow-out.txt");
});

test("blocking gate failure → outcome=gated_failure with evidence", async () => {
  const spec: WorkflowSpec = {
    name: "gated",
    description: "gated",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    process_gates: ["verification-before-complete"],
    run: { kind: "markdown-template", template: "I think this works. Done." },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: "/tmp",
  });
  expect(result.outcome).toBe("gated_failure");
  expect(result.gateEvidence?.["verification-before-complete"]).toContain("think");
});

test("passing gate keeps success outcome", async () => {
  const spec: WorkflowSpec = {
    name: "gated-ok",
    description: "gated-ok",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    process_gates: ["verification-before-complete"],
    run: { kind: "markdown-template", template: "I ran `bun test` and saw 12 pass. Done." },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: "/tmp",
  });
  expect(result.outcome).toBe("success");
});

test("spec listing unsatisfiable process_gate → outcome=run_error (fail-closed)", async () => {
  for (const gate of ["tdd", "brainstorm-first", "worktree-isolation"] as const) {
    const spec: WorkflowSpec = {
      name: `unsat-${gate}`,
      description: "u",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [],
      process_gates: [gate],
      run: { kind: "markdown-template", template: "anything" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: "/tmp",
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("executor cannot satisfy");
    expect(result.errorMessage).toContain(gate);
    expect(result.artifacts).toEqual([]);
  }
});

test("required task sink failure → outcome=run_error (daemon unreachable)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-"));
  try {
    const spec: WorkflowSpec = {
      name: "task-required-fail",
      description: "t",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [{ kind: "task", prompt: "do thing" }],
      run: { kind: "markdown-template", template: "body" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("required output sink");
    expect(result.warnings.some((w) => w.includes("daemon port/token not found"))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("optional task sink failure → outcome=success with warning preserved", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-"));
  try {
    const spec: WorkflowSpec = {
      name: "task-optional-fail",
      description: "t",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [{ kind: "task", prompt: "do thing", optional: true }],
      run: { kind: "markdown-template", template: "body" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.warnings.some((w) => w.includes("daemon port/token not found"))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("required observation sink failure → outcome=run_error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-"));
  try {
    const spec: WorkflowSpec = {
      name: "obs-required-fail",
      description: "o",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [{ kind: "observation" }],
      run: { kind: "markdown-template", template: "body" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("required output sink");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("optional observation sink failure → outcome=success", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-"));
  try {
    const spec: WorkflowSpec = {
      name: "obs-optional-fail",
      description: "o",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [{ kind: "observation", optional: true }],
      run: { kind: "markdown-template", template: "body" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.warnings.some((w) => w.includes("daemon port/token not found"))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("required file sink blocked outside repo root → outcome=run_error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-"));
  try {
    const repoRoot = join(tmp, "repo");
    const spec: WorkflowSpec = {
      name: "file-required-fail",
      description: "f",
      triggers: [{ kind: "manual" }],
      recall: [],
      output: [{ kind: "file", path: join(tmp, "outside.md") }],
      run: { kind: "markdown-template", template: "body" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
      repoRoot,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("required output sink");
    expect(result.errorMessage).toContain("file");
    expect(result.warnings.some((w) => w.includes("outside the allowed root"))).toBe(true);
    expect(result.artifacts).toEqual([]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("captureCtx wires capture and writes t0 + workflow_stats rows", async () => {
  if (process.platform === "darwin") {
    try {
      Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
    } catch {
      // already loaded
    }
  }
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const spec: WorkflowSpec = {
    name: "capture-demo",
    description: "d",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    run: { kind: "markdown-template", template: "OK" },
  };
  await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: "/tmp",
    captureCtx: { db, project: "p", sessionId: "s", userId: "u", machineId: "m" },
  });
  const stats = db
    .query("SELECT samples, successes FROM workflow_stats WHERE workflow_name='capture-demo'")
    .get() as { samples: number; successes: number };
  expect(stats.samples).toBe(1);
  expect(stats.successes).toBe(1);
});
