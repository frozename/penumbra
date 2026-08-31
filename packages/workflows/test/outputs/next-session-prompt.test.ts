import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitNextSessionPromptOutput } from "@src/outputs/next-session-prompt.js";

test("an empty-after-trim body returns skipped true, distinct from a write failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-next-session-prompt-"));
  try {
    const emptyResult = await emitNextSessionPromptOutput({
      body: " \n\t ",
      storageRoot: join(root, "empty"),
      workflowName: "empty-workflow",
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
    });

    expect(writeFailureResult.skipped).not.toBe(true);
    expect(writeFailureResult.path).toBeUndefined();
    expect(writeFailureResult.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
