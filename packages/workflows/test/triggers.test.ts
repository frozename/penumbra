import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry } from '../src/registry.js';
import { evaluateTriggerEvent, evaluateStateThresholds } from '../src/triggers.js';

const PB = (name: string, triggers: string) => `---
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

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tr-'));
  const playbooks = join(root, 'playbooks');
  const workflows = join(root, 'workflows');
  mkdirSync(join(playbooks, 'a'), { recursive: true });
  mkdirSync(join(playbooks, 'b'), { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(playbooks, 'a', 'playbook.md'), PB('a', '  - kind: lifecycle\n    event: pre-compact'));
  writeFileSync(join(playbooks, 'b', 'playbook.md'), PB('b', '  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 30'));
  const reg = await buildRegistry({ playbooksDir: playbooks, workflowsDir: workflows });
  return { reg, root };
}

test('evaluateTriggerEvent routes pre-compact lifecycle to matching specs', async () => {
  const { reg, root } = await setup();
  try {
    const matched = evaluateTriggerEvent(reg, { kind: 'lifecycle', event: 'pre-compact' });
    expect(matched.map((s) => s.name)).toEqual(['a']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evaluateStateThresholds matches when metric crosses', async () => {
  const { reg, root } = await setup();
  try {
    const metrics = { 'queue-idle-min': 45, 'time-since-last-handoff-min': 0, 'pending-handoffs': 0 };
    const matched = evaluateStateThresholds(reg, metrics);
    expect(matched.map((s) => s.name)).toEqual(['b']);
    const noMatch = evaluateStateThresholds(reg, { ...metrics, 'queue-idle-min': 10 });
    expect(noMatch).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
