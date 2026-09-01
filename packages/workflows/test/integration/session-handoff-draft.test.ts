import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRegistry, evaluateTriggerEvent } from "@src/index.js";

test("registry loads session-handoff-draft with only chain-capable triggers", async () => {
  const repoRoot = join(import.meta.dir, "../../../..");
  const root = mkdtempSync(join(repoRoot, ".session-handoff-draft-reg-"));
  const playbookSrc = join(repoRoot, "plugin/playbooks/session-handoff");
  const workflowSrc = join(repoRoot, "plugin/workflows/session-handoff-draft");
  try {
    const playbookDir = join(root, "playbooks/session-handoff");
    const workflowDir = join(root, "workflows/session-handoff-draft");
    mkdirSync(playbookDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(playbookDir, "playbook.md"),
      readFileSync(join(playbookSrc, "playbook.md"), "utf8"),
    );
    writeFileSync(
      join(workflowDir, "workflow.ts"),
      readFileSync(join(workflowSrc, "workflow.ts"), "utf8"),
    );

    const registry = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });

    expect(registry.errors).toEqual([]);
    const handoff = registry.get("session-handoff");
    const draft = registry.get("session-handoff-draft");
    expect(draft).toBeDefined();
    expect(draft?.triggers).toEqual([
      { kind: "lifecycle", event: "pre-compact" },
      { kind: "slash", command: "handoff" },
    ]);
    expect(draft?.triggers).not.toEqual(handoff?.triggers);
    expect(
      evaluateTriggerEvent(registry, { kind: "lifecycle", event: "pre-compact" }).map(
        (spec) => spec.name,
      ),
    ).toEqual(["session-handoff", "session-handoff-draft"]);
    expect(
      evaluateTriggerEvent(registry, { kind: "slash", command: "handoff" }).map(
        (spec) => spec.name,
      ),
    ).toEqual(["session-handoff", "session-handoff-draft"]);
    expect(
      evaluateTriggerEvent(registry, {
        kind: "state-threshold",
        metric: "time-since-last-handoff-min",
        op: ">",
        value: 25,
      }).map((spec) => spec.name),
    ).toEqual(["session-handoff"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
