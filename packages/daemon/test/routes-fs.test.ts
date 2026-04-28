import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { worktreesGlobRoute, worktreesGrepRoute } from '../src/routes/fs.js';

function fakeServices(worktrees: Record<string, string>): any {
  return {
    worktreeManager: {
      getWorktree: (id: string) => worktrees[id] ? { handoffId: id, path: worktrees[id] } : null,
    },
  };
}

describe('worktrees fs routes', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-fs-'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TODO\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('glob: returns 404 when handoff is unknown', async () => {
    const services = fakeServices({});
    const req = new Request('http://x/worktrees/UNKNOWN/glob', {
      method: 'POST',
      body: JSON.stringify({ pattern: '*.ts' }),
    });
    const res = await worktreesGlobRoute(req, 'UNKNOWN', services);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('glob: returns matches on happy path', async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request('http://x/worktrees/H1/glob', {
      method: 'POST',
      body: JSON.stringify({ pattern: '*.ts' }),
    });
    const res = await worktreesGlobRoute(req, 'H1', services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual(['a.ts']);
  });

  it('glob: returns 400 when args.path resolves outside worktree', async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request('http://x/worktrees/H1/glob', {
      method: 'POST',
      body: JSON.stringify({ pattern: '*.ts', path: '/etc' }),
    });
    const res = await worktreesGlobRoute(req, 'H1', services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('outside_worktree');
  });

  it('grep: returns matches on happy path', async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request('http://x/worktrees/H1/grep', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'TODO', output_mode: 'content' }),
    });
    const res = await worktreesGrepRoute(req, 'H1', services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].text).toBe('TODO');
  });

  it('grep: returns 404 when handoff is unknown', async () => {
    const services = fakeServices({});
    const req = new Request('http://x/worktrees/UNKNOWN/grep', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'TODO' }),
    });
    const res = await worktreesGrepRoute(req, 'UNKNOWN', services);
    expect(res.status).toBe(404);
  });
});
