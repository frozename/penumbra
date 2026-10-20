import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  emitNextSessionPromptOutput,
  type NextSessionPromptResult,
  PRESERVE_NEXT_SESSION_PROMPT,
} from "@src/outputs/next-session-prompt.js";

test("an empty-after-trim body returns skipped true, distinct from a write failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-next-session-prompt-"));
  try {
    const emptyResult = await emitNextSessionPromptOutput({
      body: " \n\t ",
      storageRoot: join(root, "empty"),
      workflowName: "empty-workflow",
      project: "alpha",
    });

    expect(emptyResult.skipped).toBe(true);
    expect(emptyResult.path).toBeUndefined();
    expect(emptyResult.warnings).toEqual([
      "output next-session-prompt: empty body — skipped write to preserve existing artifact",
    ]);

    const storageRootFile = join(root, "not-a-directory");
    writeFileSync(storageRootFile, "occupied");
    const writeFailureResult = await emitNextSessionPromptOutput({
      body: "non-empty",
      storageRoot: storageRootFile,
      workflowName: "write-failure-workflow",
      project: "alpha",
    });

    expect(writeFailureResult.skipped).not.toBe(true);
    expect(writeFailureResult.path).toBeUndefined();
    expect(writeFailureResult.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each project writes its own pending-handoff file and never the legacy global one", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-next-session-prompt-"));
  try {
    const legacy = join(root, "pending-handoff.md");
    writeFileSync(legacy, "hand-written note from another lineage\n");

    const a = await emitNextSessionPromptOutput({
      body: "alpha checkpoint",
      storageRoot: root,
      workflowName: "session-handoff-stop",
      project: "alpha",
    });
    const b = await emitNextSessionPromptOutput({
      body: "beta checkpoint",
      storageRoot: root,
      workflowName: "session-handoff-stop",
      project: "beta",
    });

    expect(a.path).toBe(join(root, "pending-handoff.alpha.md"));
    expect(b.path).toBe(join(root, "pending-handoff.beta.md"));
    const alpha = readFileSync(join(root, "pending-handoff.alpha.md"), "utf8");
    const beta = readFileSync(join(root, "pending-handoff.beta.md"), "utf8");
    expect(alpha).toContain("alpha checkpoint");
    expect(alpha).not.toContain("beta checkpoint");
    expect(beta).toContain("beta checkpoint");
    expect(beta).not.toContain("alpha checkpoint");
    expect(readFileSync(legacy, "utf8")).toBe("hand-written note from another lineage\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project id that is not filename-safe is hashed into a file directly under storageRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-next-session-prompt-"));
  try {
    const r = await emitNextSessionPromptOutput({
      body: "synthetic project checkpoint",
      storageRoot: root,
      workflowName: "session-handoff-stop",
      project: "0123456789abcdef:packages/../../escape",
    });

    expect(r.path).toBeDefined();
    expect(dirname(r.path ?? "")).toBe(root);
    expect(basename(r.path ?? "")).toMatch(/^pending-handoff\.[0-9a-f]{16}\.md$/);
    expect(readdirSync(root)).toEqual([basename(r.path ?? "")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports whether it created the file, appended a section or replaced its own section", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-next-session-prompt-"));
  try {
    const emit = (workflowName: string, body: string): Promise<NextSessionPromptResult> =>
      emitNextSessionPromptOutput({ body, storageRoot: root, workflowName, project: "alpha" });

    expect((await emit("session-handoff-stop", "v1")).mode).toBe("created");
    expect((await emit("session-memory-sweep", "sweep v1")).mode).toBe("section_appended");
    expect((await emit("session-handoff-stop", "v2")).mode).toBe("section_replaced");

    const preserved = await emitNextSessionPromptOutput({
      body: PRESERVE_NEXT_SESSION_PROMPT,
      storageRoot: root,
      workflowName: "session-memory-sweep",
      project: "alpha",
    });
    expect(preserved.mode).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-emitting a section keeps replacement-pattern text in the body literal", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-next-session-prompt-"));
  try {
    const body = "run `sed 's/x/$&$&/'` then $1";
    for (let i = 0; i < 2; i++) {
      await emitNextSessionPromptOutput({
        body,
        storageRoot: root,
        workflowName: "session-handoff-stop",
        project: "alpha",
      });
    }

    const text = readFileSync(join(root, "pending-handoff.alpha.md"), "utf8");
    expect(text.split(body)).toHaveLength(2);
    expect(text.split("<!-- penumbra:section session-handoff-stop -->")).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
