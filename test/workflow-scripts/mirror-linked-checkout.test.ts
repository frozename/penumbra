import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as init from "../../packages/cli/src/commands/init.js";

test("mirror drift reuses the structural checkout guard and skips linked checkouts", () => {
  const helper = (init as unknown as { isLinkedCheckout?: (path: string) => boolean })
    .isLinkedCheckout;
  expect(typeof helper).toBe("function");
  const root = mkdtempSync(join(tmpdir(), "mirror-checkout-"));
  try {
    writeFileSync(join(root, ".git"), "gitdir: /unused\n");
    mkdirSync(join(root, "nested"));
    expect(helper?.(join(root, "nested"))).toBe(true);
    rmSync(join(root, ".git"));
    mkdirSync(join(root, ".git"));
    expect(helper?.(join(root, "nested"))).toBe(false);
    const guard = readFileSync("test/workflow-scripts/mirror-drift.test.ts", "utf8");
    expect(guard).toContain("import { isLinkedCheckout }");
    expect(guard).toContain("if (isLinkedCheckout(REPO_DIR))");
    expect(guard).toContain('describe.skip("global workflow mirror drift (linked checkout)"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
