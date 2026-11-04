import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowCtx } from "../src/ctx.js";
import type { WorkflowSpec } from "../src/schema.js";

import { executeWorkflow } from "../src/exec.js";

function makeCtx(
  onDispose: () => void,
  fileWrite: (p: string, b: string) => Promise<string> = (): Promise<string> =>
    Promise.resolve("/tmp/unused.txt"),
): WorkflowCtx & { dispose: () => void } {
  return {
    dispatch: (): Promise<{ conversation_id: string; handoff_id: string }> =>
      Promise.resolve({ conversation_id: "conv", handoff_id: "hid" }),
    awaitChain: (): Promise<{
      status: "completed";
      final_agent: string | null;
      response_text: string | null;
    }> => Promise.resolve({ status: "completed", final_agent: "codex", response_text: "ok" }),
    cancel: (): Promise<void> => Promise.resolve(),
    fileWrite,
    config: {},
    cwd: "/tmp",
    storageRoot: "/tmp",
    project: "proj",
    args: {},
    dispose: onDispose,
  };
}

const EMPTY_BUNDLE = { byKey: {}, warnings: [], estimatedTokens: 0 };
const FIXED_NOW = (): Date => new Date("2026-01-01T00:00:00.000Z");

function tsSpec(name: string, output: WorkflowSpec["output"] = []): WorkflowSpec {
  return {
    name,
    description: name,
    triggers: [{ kind: "manual" }],
    recall: [],
    output,
    run: { kind: "ts-function" },
  };
}

function markdownSpec(
  name: string,
  template: string,
  output: WorkflowSpec["output"] = [],
): WorkflowSpec {
  return {
    name,
    description: name,
    triggers: [{ kind: "manual" }],
    recall: [],
    output,
    run: { kind: "markdown-template", template },
  };
}

test("ts-function spec with no fn bound → run_error with no artifacts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const result = await executeWorkflow({
      spec: tsSpec("no-fn"),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("ts-function workflow has no fn bound");
    expect(result.artifacts).toEqual([]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispose runs exactly once after fn resolves", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    let disposals = 0;
    const fn = (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true });
    const result = await executeWorkflow({
      spec: tsSpec("dispose-after-ok"),
      bundle: EMPTY_BUNDLE,
      fn,
      ctx: makeCtx(() => {
        disposals += 1;
      }),
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(disposals).toBe(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispose runs exactly once when fn throws", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    let disposals = 0;
    const fn = (): Promise<unknown> => Promise.reject(new Error("boom"));
    const result = await executeWorkflow({
      spec: tsSpec("dispose-after-throw"),
      bundle: EMPTY_BUNDLE,
      fn,
      ctx: makeCtx(() => {
        disposals += 1;
      }),
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(disposals).toBe(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("markdown-template spec disposes once and never invokes a provided fn", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    let disposals = 0;
    let fnCalls = 0;
    const fn = (): Promise<string> => {
      fnCalls += 1;
      return Promise.resolve("never");
    };
    const result = await executeWorkflow({
      spec: markdownSpec("markdown-dispose", "x"),
      bundle: EMPTY_BUNDLE,
      fn,
      ctx: makeCtx(() => {
        disposals += 1;
      }),
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(disposals).toBe(1);
    expect(fnCalls).toBe(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispose does not run on a pre-run failure", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    let disposals = 0;
    const spec: WorkflowSpec = {
      ...tsSpec("prerun-no-dispose"),
      process_gates: ["tdd"],
    };
    const result = await executeWorkflow({
      spec,
      bundle: EMPTY_BUNDLE,
      ctx: makeCtx(() => {
        disposals += 1;
      }),
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(disposals).toBe(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fn calling ctx.fileWrite without opts.ctx → run_error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const fn = (ctx: WorkflowCtx): Promise<string> => ctx.fileWrite("x.txt", "b");
    const result = await executeWorkflow({
      spec: tsSpec("no-ctx-filewrite"),
      bundle: EMPTY_BUNDLE,
      fn,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("workflow ctx.fileWrite is not available");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("artifact written before an fn throw is kept on run_error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const fn = async (ctx: WorkflowCtx): Promise<unknown> => {
      await ctx.fileWrite("partial.txt", "b");
      throw new Error("boom");
    };
    const result = await executeWorkflow({
      spec: tsSpec("partial-artifact"),
      bundle: EMPTY_BUNDLE,
      fn,
      ctx: makeCtx(
        () => undefined,
        (): Promise<string> => Promise.resolve("/tmp/partial.txt"),
      ),
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.artifacts).toEqual(["/tmp/partial.txt"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("invalid templateCtx tz → render_error, not run_error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("bad-tz", "{{date}}"),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
      templateCtx: {
        now: FIXED_NOW,
        project: "p",
        sessionStart: "s",
        tz: "Not/A_Zone",
      },
    });
    expect(result.outcome).toBe("render_error");
    expect(result.errorMessage).toBeDefined();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bodyFromRunResult: string runResult becomes sessionReminder verbatim", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const fn = (): Promise<string> => Promise.resolve("hello");
    const result = await executeWorkflow({
      spec: tsSpec("body-string", [{ kind: "session-reminder" }]),
      bundle: EMPTY_BUNDLE,
      fn,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.sessionReminder).toBe("hello");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bodyFromRunResult: object runResult becomes JSON in sessionReminder", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const fn = (): Promise<{ a: number }> => Promise.resolve({ a: 1 });
    const result = await executeWorkflow({
      spec: tsSpec("body-object", [{ kind: "session-reminder" }]),
      bundle: EMPTY_BUNDLE,
      fn,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.sessionReminder).toBe('{"a":1}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bodyFromRunResult: undefined runResult becomes {} in sessionReminder", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const fn = (): Promise<undefined> => Promise.resolve(undefined);
    const result = await executeWorkflow({
      spec: tsSpec("body-undefined", [{ kind: "session-reminder" }]),
      bundle: EMPTY_BUNDLE,
      fn,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.sessionReminder).toBe("{}");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("nestDottedKeys: nested key overwrites colliding scalar parent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("nest-collision", "{{recall.a.b}}"),
      bundle: { byKey: { a: "scalar", "a.b": "deep" }, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.composedPrompt).toBe("deep");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("nestDottedKeys: sibling dotted keys share a parent object", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("nest-siblings", "{{recall.git.log}}|{{recall.git.status}}"),
      bundle: { byKey: { "git.log": "L", "git.status": "S" }, warnings: [], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.composedPrompt).toBe("L|S");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle warnings are preserved ahead of template missing-var warnings", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-run-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("warn-order", "{{recall.missing}}"),
      bundle: { byKey: {}, warnings: ["recall: w1"], estimatedTokens: 0 },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.warnings).toEqual(["recall: w1", "template: {{recall.missing}} missing"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
