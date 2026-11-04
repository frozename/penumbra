import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry } from "../src/registry.js";
import { evaluateStateThresholds, type StateMetrics } from "../src/triggers.js";

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

function metrics(overrides: Partial<StateMetrics>): StateMetrics {
  return {
    "queue-idle-min": 0,
    "time-since-last-handoff-min": 0,
    "pending-handoffs": 0,
    "commits-since-last-handoff": 0,
    "context-window-percent": 0,
    "pending-review-lanes": 0,
    ...overrides,
  };
}

async function setup(triggers: string): Promise<{
  root: string;
  reg: Awaited<ReturnType<typeof import("../src/registry.js").buildRegistry>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "ts-"));
  const playbooks = join(root, "playbooks");
  const workflows = join(root, "workflows");
  mkdirSync(join(playbooks, "a"), { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(playbooks, "a", "playbook.md"), PB("a", triggers));
  const reg = await buildRegistry({ playbooksDir: playbooks, workflowsDir: workflows });
  return { reg, root };
}

test("state-threshold '>' is strict: metric exactly at threshold does not fire", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 30',
  );
  try {
    const matched = evaluateStateThresholds(reg, metrics({ "queue-idle-min": 30 }));
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state-threshold '<' fires when metric is below the value", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: context-window-percent\n    op: "<"\n    value: 20',
  );
  try {
    const matched = evaluateStateThresholds(reg, metrics({ "context-window-percent": 10 }));
    expect(matched.map((s) => s.name)).toEqual(["a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state-threshold '<' is strict: metric exactly at threshold does not fire", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: context-window-percent\n    op: "<"\n    value: 20',
  );
  try {
    const matched = evaluateStateThresholds(reg, metrics({ "context-window-percent": 20 }));
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trigger reads its own metric, not another", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: pending-handoffs\n    op: ">"\n    value: 2',
  );
  try {
    const matched = evaluateStateThresholds(reg, metrics({ "pending-handoffs": 0 }));
    expect(matched).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("any later threshold trigger can fire the spec", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 1000\n  - kind: state-threshold\n    metric: pending-review-lanes\n    op: ">"\n    value: 1',
  );
  try {
    const matched = evaluateStateThresholds(reg, metrics({ "pending-review-lanes": 5 }));
    expect(matched.map((s) => s.name)).toEqual(["a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-threshold triggers are skipped, not terminal", async () => {
  const { reg, root } = await setup(
    '  - kind: lifecycle\n    event: pre-compact\n  - kind: state-threshold\n    metric: commits-since-last-handoff\n    op: ">"\n    value: 3',
  );
  try {
    const matched = evaluateStateThresholds(reg, metrics({ "commits-since-last-handoff": 10 }));
    expect(matched.map((s) => s.name)).toEqual(["a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spec with two satisfied threshold triggers is returned once", async () => {
  const { reg, root } = await setup(
    '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 1\n  - kind: state-threshold\n    metric: pending-handoffs\n    op: ">"\n    value: 1',
  );
  try {
    const matched = evaluateStateThresholds(
      reg,
      metrics({ "queue-idle-min": 5, "pending-handoffs": 5 }),
    );
    expect(matched).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
