import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowsListRoute } from '../../src/routes/workflows.js';
import { buildRegistry } from '../../../workflows/src/registry.js';

async function setupReg() {
  const root = mkdtempSync(join(tmpdir(), 'wfd-'));
  mkdirSync(join(root, 'playbooks/x'), { recursive: true });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  writeFileSync(
    join(root, 'playbooks/x/playbook.md'),
    `---\nname: x\ndescription: D\ntriggers:\n  - kind: manual\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
  );
  const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
  return { reg, root };
}

test('GET /workflows/list returns registry list', async () => {
  const { reg, root } = await setupReg();
  try {
    const services = { workflowRegistry: reg } as any;
    const req = new Request('http://localhost/workflows/list');
    const res = await workflowsListRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ name: string; description: string }> };
    expect(body.workflows.map((w) => w.name)).toEqual(['x']);
    expect(body.workflows[0].description).toBe('D');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
