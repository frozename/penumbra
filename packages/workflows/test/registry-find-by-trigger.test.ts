import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry } from "../src/registry.js";

const PB = (name: string, triggers: string): string => `---
name: ${name}
description: d
triggers:
${triggers}
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body
`;

async function setup(triggers: string): Promise<{
  root: string;
  reg: Awaited<ReturnType<typeof import("../src/registry.js").buildRegistry>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "rft-"));
  const playbooks = join(root, "playbooks");
  const workflows = join(root, "workflows");
  mkdirSync(join(playbooks, "a"), { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(playbooks, "a", "playbook.md"), PB("a", triggers));
  const reg = await buildRegistry({ playbooksDir: playbooks, workflowsDir: workflows });
  return { reg, root };
}

test("findByTrigger value must match", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 30',
  );
  try {
    const matched31 = reg.findByTrigger({
      kind: "state-threshold",
      metric: "queue-idle-min",
      op: ">",
      value: 31,
    });
    expect(matched31).toEqual([]);
    const matched30 = reg.findByTrigger({
      kind: "state-threshold",
      metric: "queue-idle-min",
      op: ">",
      value: 30,
    });
    expect(matched30.map((s) => s.name)).toEqual(["a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findByTrigger op must match", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 30',
  );
  try {
    const matched = reg.findByTrigger({
      kind: "state-threshold",
      metric: "queue-idle-min",
      op: "<",
      value: 30,
    });
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findByTrigger metric must match", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 30',
  );
  try {
    const matched = reg.findByTrigger({
      kind: "state-threshold",
      metric: "pending-handoffs",
      op: ">",
      value: 30,
    });
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findByTrigger lifecycle event name must match", async () => {
  const { reg, root } = await setup("  - kind: lifecycle\n    event: pre-compact");
  try {
    const matched = reg.findByTrigger({ kind: "lifecycle", event: "stop" });
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findByTrigger kinds must match", async () => {
  const { reg, root } = await setup("  - kind: manual");
  try {
    const matched = reg.findByTrigger({ kind: "slash", command: "anything" });
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spec with two matching triggers is returned once", async () => {
  const { reg, root } = await setup(
    "  - kind: lifecycle\n    event: pre-compact\n  - kind: lifecycle\n    event: pre-compact",
  );
  try {
    const matched = reg.findByTrigger({ kind: "lifecycle", event: "pre-compact" });
    expect(matched).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
