import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanValidate } from '../../src/commands/plan.js';

const dirs: string[] = [];
let prevEnv: string | undefined;
const KNOWN_AGENTS = new Set(['codex-acp-fast', 'claude-acp-sonnet']);

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PENUMBRA_PROJECTS_YAML;
  else process.env.PENUMBRA_PROJECTS_YAML = prevEnv;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'plan-validate-cross-project-'));
  dirs.push(d);
  return d;
}

function writeRegistry(path: string, ids: string[]): void {
  prevEnv = process.env.PENUMBRA_PROJECTS_YAML;
  const lines = ['projects:'];
  for (const id of ids) {
    lines.push(`  - project_id: ${id}`);
    lines.push(`    root_path: /tmp/${id}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
  process.env.PENUMBRA_PROJECTS_YAML = path;
}

function planMd(): string {
  return `---
plan_id: demo
home_project: penumbra
---

## Phase 1

### Task 1.1

\`\`\`yaml meta
id: '1.1'
files: ['x.ts']
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
\`\`\`

### Task 2.1

\`\`\`yaml meta
id: '2.1'
project: sirius
files: ['y.ts']
file_scope: new
depends_on: ['penumbra/1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
\`\`\`
`;
}

test('valid plan with qualified deps + registered home_project exits 0', async () => {
  const dir = tmpDir();
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, planMd());
  const regPath = join(dir, 'projects.yaml');
  writeRegistry(regPath, ['penumbra', 'sirius']);
  const result = await runPlanValidate({
    path: planPath,
    knownAgents: KNOWN_AGENTS,
    out: () => {},
    err: () => {},
  });
  expect(result).toBe(0);
});

test('home_project not in registry exits 2 with clear message', async () => {
  const dir = tmpDir();
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, planMd().replace('home_project: penumbra', 'home_project: nonexistent'));
  const regPath = join(dir, 'projects.yaml');
  writeRegistry(regPath, ['penumbra', 'sirius']);
  const errs: string[] = [];
  const result = await runPlanValidate({
    path: planPath,
    knownAgents: KNOWN_AGENTS,
    out: () => {},
    err: (s) => errs.push(s),
  });
  expect(result).toBe(2);
  expect(errs.join('\n')).toContain('nonexistent');
  expect(errs.join('\n')).toContain('unknown_project');
});

test('--no-registry skips project-membership rule', async () => {
  const dir = tmpDir();
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, planMd().replace('home_project: penumbra', 'home_project: foo'));
  const regPath = join(dir, 'projects.yaml');
  writeRegistry(regPath, ['penumbra', 'sirius']);
  const errs: string[] = [];
  const result = await runPlanValidate({
    path: planPath,
    noRegistry: true,
    knownAgents: KNOWN_AGENTS,
    out: () => {},
    err: (s) => errs.push(s),
  });
  expect(result).toBe(2);
  expect(errs.join('\n')).not.toContain('unknown_project');
  expect(errs.join('\n')).not.toContain("'foo'");
});
