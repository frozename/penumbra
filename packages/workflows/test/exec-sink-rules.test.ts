import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowSpec } from "../src/schema.js";

import { executeWorkflow } from "../src/exec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

const EMPTY_BUNDLE = { byKey: {}, warnings: [], estimatedTokens: 0 };
const FIXED_NOW = (): Date => new Date("2026-01-01T00:00:00.000Z");

function markdownSpec(
  name: string,
  template: string,
  output: WorkflowSpec["output"],
  processGates?: WorkflowSpec["process_gates"],
): WorkflowSpec {
  return {
    name,
    description: name,
    triggers: [{ kind: "manual" }],
    recall: [],
    ...(processGates ? { process_gates: processGates } : {}),
    output,
    run: { kind: "markdown-template", template },
  };
}

function migratedDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test("unsatisfiable process_gate is reported before unsatisfiable output kinds", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec(
        "prerun-precedence",
        "anything",
        [{ kind: "commit", message: "x" }],
        ["tdd"],
      ),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("process_gates the executor cannot satisfy: tdd");
    expect(result.errorMessage).not.toContain("output kinds");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("all required recall failures join into one errorMessage", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("recall-failures", "anything", []),
      bundle: {
        byKey: {},
        warnings: [],
        estimatedTokens: 0,
        requiredFailures: [
          { source: "git.log", message: "boom" },
          { source: "memory_search", message: "nope" },
        ],
      },
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("git.log: boom; memory_search: nope");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("blocking gate failure stops every output sink", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  try {
    const outPath = join(tmp, "out.md");
    const result = await executeWorkflow({
      spec: markdownSpec(
        "gate-stops-sinks",
        "I think this works. Done.",
        [{ kind: "file", path: outPath }],
        ["verification-before-complete"],
      ),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
    });
    expect(result.outcome).toBe("gated_failure");
    expect(result.artifacts).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("multiple required sink failures join with a semicolon separator", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  try {
    const repoRoot = join(tmp, "repo");
    const result = await executeWorkflow({
      spec: markdownSpec("two-sink-failures", "body", [
        { kind: "file", path: join(tmp, "a.md") },
        { kind: "file", path: join(tmp, "b.md") },
      ]),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
      repoRoot,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage?.startsWith("required output sink(s) failed — ")).toBe(true);
    expect(result.errorMessage).toContain("; file: ");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("later sinks still run after an earlier required sink failure", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  try {
    const repoRoot = join(tmp, "repo");
    const result = await executeWorkflow({
      spec: markdownSpec("sink-continues", "pulse", [
        { kind: "file", path: join(tmp, "a.md") },
        { kind: "session-reminder" },
      ]),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
      repoRoot,
    });
    expect(result.outcome).toBe("run_error");
    expect(result.sessionReminder).toBe("pulse");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("template project defaults to unknown without templateCtx or captureCtx", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("default-project", "body", [
        { kind: "file", path: join(tmp, "{{project}}.md") },
      ]),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
      repoRoot: tmp,
    });
    expect(result.outcome).toBe("success");
    expect(result.artifacts).toContain(join(tmp, "unknown.md"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("captureCtx project is used when no templateCtx is given", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  const db = migratedDb();
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("capture-project", "body", [
        { kind: "file", path: join(tmp, "{{project}}.md") },
      ]),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
      repoRoot: tmp,
      captureCtx: {
        db,
        project: "cap",
        sessionId: "s",
        userId: "u",
        machineId: "m",
        now: FIXED_NOW,
      },
    });
    expect(result.outcome).toBe("success");
    expect(result.artifacts).toContain(join(tmp, "cap.md"));
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("explicit templateCtx project wins over captureCtx project", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  const db = migratedDb();
  try {
    const result = await executeWorkflow({
      spec: markdownSpec("template-project", "body", [
        { kind: "file", path: join(tmp, "{{project}}.md") },
      ]),
      bundle: EMPTY_BUNDLE,
      storageRoot: tmp,
      repoRoot: tmp,
      templateCtx: { now: FIXED_NOW, project: "tpl", sessionStart: "s", tz: "UTC" },
      captureCtx: {
        db,
        project: "cap",
        sessionId: "s",
        userId: "u",
        machineId: "m",
        now: FIXED_NOW,
      },
    });
    expect(result.outcome).toBe("success");
    expect(result.artifacts).toContain(join(tmp, "tpl.md"));
    expect(result.artifacts).not.toContain(join(tmp, "cap.md"));
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("workflow.recall capture records item_count and sources", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "exec-sink-rules-"));
  const db = migratedDb();
  try {
    const spec: WorkflowSpec = {
      name: "recall-capture",
      description: "recall-capture",
      triggers: [{ kind: "manual" }],
      recall: [
        { source: "git.log", args: {} },
        { source: "memory_search", args: {} },
      ],
      output: [],
      run: { kind: "markdown-template", template: "OK" },
    };
    const result = await executeWorkflow({
      spec,
      bundle: {
        byKey: { a: [1, 2, 3], b: "x", c: "", d: null },
        warnings: [],
        estimatedTokens: 0,
      },
      storageRoot: tmp,
      captureCtx: { db, project: "p", sessionId: "s", userId: "u", machineId: "m", now: FIXED_NOW },
    });
    expect(result.outcome).toBe("success");
    const row = db
      .query("SELECT payload_json FROM t0_events WHERE event_type='workflow.recall'")
      .get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { item_count: number; sources: string[] };
    expect(payload.item_count).toBe(4);
    expect(payload.sources).toEqual(["git.log", "memory_search"]);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
