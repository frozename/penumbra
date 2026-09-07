import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowSpec } from "../src/schema.js";

import { executeWorkflow } from "../src/exec.js";
import { composeRecall, isEmptyRecallValue } from "../src/recall.js";

const stubEmbedder = { embed: (): Promise<Float32Array[]> => Promise.resolve([]) };

test("isEmptyRecallValue treats degraded source payloads as empty", () => {
  expect(isEmptyRecallValue(null)).toBe(true);
  expect(isEmptyRecallValue(undefined)).toBe(true);
  expect(isEmptyRecallValue("")).toBe(true);
  expect(isEmptyRecallValue("   ")).toBe(true);
  expect(isEmptyRecallValue([])).toBe(true);
  expect(isEmptyRecallValue({})).toBe(true);
  expect(isEmptyRecallValue({ path: "x", body: null, error: "not_found" })).toBe(true);
  expect(isEmptyRecallValue("abc123 subject")).toBe(false);
  expect(isEmptyRecallValue([{ id: 1 }])).toBe(false);
  expect(isEmptyRecallValue({ path: "x", body: "hello", truncated: false })).toBe(false);
});

test("composeRecall records a required source that degrades to an empty value", async () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "recall-required-nonrepo-"));
  try {
    const bundle = await composeRecall({
      db: new Database(":memory:"),
      embedder: stubEmbedder,
      cwd: nonRepo,
      repoRoot: nonRepo,
      project: "p",
      sources: [{ source: "git.log", args: { range: "HEAD~5..HEAD" }, required: true }],
    });
    expect(bundle.warnings.join("\n")).toContain("not a git repository");
    expect(bundle.requiredFailures).toEqual([
      { source: "git.log", message: "source produced no usable content" },
    ]);
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("composeRecall leaves optional sources alone", async () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "recall-optional-nonrepo-"));
  try {
    const bundle = await composeRecall({
      db: new Database(":memory:"),
      embedder: stubEmbedder,
      cwd: nonRepo,
      repoRoot: nonRepo,
      project: "p",
      sources: [{ source: "git.log", args: { range: "HEAD~5..HEAD" } }],
    });
    expect(bundle.requiredFailures ?? []).toEqual([]);
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("executeWorkflow fails closed and writes no artifact when a required source failed", async () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "recall-required-exec-"));
  const out = mkdtempSync(join(tmpdir(), "recall-required-out-"));
  try {
    const outPath = join(out, "continuation.md");
    const spec: WorkflowSpec = {
      name: "hollow-handoff",
      description: "reproduces the hollow continuation note",
      triggers: [{ kind: "manual" }],
      recall: [{ source: "git.log", args: { range: "HEAD~5..HEAD" }, required: true }],
      output: [{ kind: "file", path: outPath }],
      run: {
        kind: "markdown-template",
        template: "# Handoff\n\n## Recent commits\n\n{{recall.git.log}}\n",
      },
    };
    const bundle = await composeRecall({
      db: new Database(":memory:"),
      embedder: stubEmbedder,
      cwd: nonRepo,
      repoRoot: nonRepo,
      project: "p",
      sources: spec.recall,
    });
    const result = await executeWorkflow({ spec, bundle, storageRoot: out });

    expect(result.outcome).toBe("run_error");
    expect(result.errorMessage).toContain("required recall source(s) failed");
    expect(result.errorMessage).toContain("git.log");
    expect(result.artifacts).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
