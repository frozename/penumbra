import { loadTsWorkflow } from "@src/loaders/ts.js";
import { expect, test } from "bun:test";
import { accessSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const TMP_NODE_MODULES = join(tmpdir(), "node_modules");
const WORKFLOWS = [
  resolve(ROOT, "plugin/workflows/adversarial-review/workflow.ts"),
  resolve(ROOT, "plugin/workflows/adversarial-plan/workflow.ts"),
];

test("loads adversarial plugin workflows through the ts loader", async () => {
  let createdLink = false;
  try {
    try {
      accessSync(TMP_NODE_MODULES);
    } catch {
      symlinkSync(resolve(ROOT, "node_modules"), TMP_NODE_MODULES, "dir");
      createdLink = true;
    }

    for (const path of WORKFLOWS) {
      const loaded = await loadTsWorkflow(path);
      expect(loaded.spec.name).toBeTruthy();
    }
  } finally {
    if (createdLink) {
      try {
        if (lstatSync(TMP_NODE_MODULES).isSymbolicLink()) {
          rmSync(TMP_NODE_MODULES, { force: true });
        }
      } catch {
        /* best effort */
      }
    }
  }
});
