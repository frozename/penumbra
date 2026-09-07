import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry } from "../src/registry.js";

const PLAYBOOK_A = `---
name: alpha
description: a
triggers:
  - kind: slash
    command: alpha
  - kind: lifecycle
    event: pre-compact
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body alpha
`;

const PLAYBOOK_B = `---
name: beta
description: b
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body beta
`;

const BAD_PLAYBOOK = `---
name: gamma
description: invalid
triggers: []
recall: []
output: []
run:
  kind: markdown-template
---
`;

function setupFixtures(): { root: string; playbooksDir: string; workflowsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "reg-"));
  const playbooksDir = join(root, "playbooks");
  const workflowsDir = join(root, "workflows");
  mkdirSync(join(playbooksDir, "alpha"), { recursive: true });
  mkdirSync(join(playbooksDir, "beta"), { recursive: true });
  mkdirSync(join(playbooksDir, "gamma"), { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(playbooksDir, "alpha", "playbook.md"), PLAYBOOK_A);
  writeFileSync(join(playbooksDir, "beta", "playbook.md"), PLAYBOOK_B);
  writeFileSync(join(playbooksDir, "gamma", "playbook.md"), BAD_PLAYBOOK);
  return { root, playbooksDir, workflowsDir };
}

test("boots registry from playbooks dir, skips invalid, indexes by name", async () => {
  const { root, playbooksDir, workflowsDir } = setupFixtures();
  try {
    const reg = await buildRegistry({ playbooksDir, workflowsDir });
    expect(
      reg
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(reg.get("alpha")?.description).toBe("a");
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.errors.map((e) => e.path).some((p) => p.includes("gamma"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findByTrigger returns matching specs", async () => {
  const { root, playbooksDir, workflowsDir } = setupFixtures();
  try {
    const reg = await buildRegistry({ playbooksDir, workflowsDir });
    const slashAlpha = reg.findByTrigger({ kind: "slash", command: "alpha" });
    expect(slashAlpha.map((s) => s.name)).toEqual(["alpha"]);
    const lifecyclePre = reg.findByTrigger({ kind: "lifecycle", event: "pre-compact" });
    expect(lifecyclePre.map((s) => s.name)).toEqual(["alpha"]);
    const manualBeta = reg.findByTrigger({ kind: "manual" });
    expect(manualBeta.map((s) => s.name)).toEqual(["beta"]);
    const slashUnknown = reg.findByTrigger({ kind: "slash", command: "zzz" });
    expect(slashUnknown).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every shipped plugin workflow and playbook loads with zero registry errors", async () => {
  const repoRoot = join(import.meta.dir, "../../..");
  const reg = await buildRegistry({
    playbooksDir: join(repoRoot, "plugin/playbooks"),
    workflowsDir: join(repoRoot, "plugin/workflows"),
  });
  // A load failure is caught per-file and pushed here, so a broken shipped
  // workflow is otherwise indistinguishable from one that was never deployed.
  expect(reg.errors).toEqual([]);
  expect(reg.list().length).toBeGreaterThanOrEqual(15);
});
