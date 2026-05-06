import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPlanCancel,
  runPlanList,
  runPlanStart,
  runPlanStatus,
  runPlanValidate,
} from '../../src/commands/plan.js';

const KNOWN_AGENTS = new Set(['codex-acp-fast', 'gemini-acp']);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'penumbra-plan-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    },
  };
}

function validBlock(id: string, opts: { parallel_with?: string[] } = {}): string {
  return [
    '```yaml meta',
    `id: "${id}"`,
    `files: [packages/foo/${id}.ts]`,
    'file_scope: modify-existing',
    'depends_on: []',
    `parallel_with: ${JSON.stringify(opts.parallel_with ?? [])}`,
    'preferred_agent: codex-acp-fast',
    'fallback_agent: gemini-acp',
    'task_size: small',
    'risk_class: paste-ready',
    '```',
  ].join('\n');
}

function planFixture(path: string): string {
  return [
    '---',
    'plan_id: ignored-by-server',
    'home_project: penumbra',
    '---',
    '',
    '# Plan',
    '',
    '```yaml meta',
    'id: "1.1"',
    'files: [packages/foo/1.1.ts]',
    'file_scope: modify-existing',
    'depends_on: []',
    'parallel_with: []',
    'preferred_agent: codex-acp-fast',
    'fallback_agent: gemini-acp',
    'task_size: small',
    'risk_class: paste-ready',
    '```',
    '',
    '```yaml meta',
    'id: "1.2"',
    'files: [packages/foo/1.2.ts]',
    'file_scope: modify-existing',
    'depends_on: ["1.1"]',
    'parallel_with: []',
    'preferred_agent: codex-acp-fast',
    'fallback_agent: gemini-acp',
    'task_size: small',
    'risk_class: paste-ready',
    '```',
    '',
  ].join('\n');
}

function planRecord(path: string, status: string, planId = 'plan_123') {
  return {
    plan: {
      plan_id: planId,
      file_path: path,
      home_project: 'penumbra',
      registered_at: 1,
      status,
    },
    tasks: [
      {
        plan_id: planId,
        task_meta_id: '1.1',
        project_id: 'penumbra',
        task_id_in_board: 'task-board-1',
        status: status === 'completed' ? 'completed' : 'running',
        last_event_ts: 1,
      },
      {
        plan_id: planId,
        task_meta_id: '1.2',
        project_id: 'penumbra',
        task_id_in_board: null,
        status: status === 'completed' ? 'completed' : 'pending',
        last_event_ts: 1,
      },
    ],
  };
}

test('runPlanValidate returns 0 for two valid yaml meta blocks', async () => {
  const path = join(workDir, 'plan.md');
  const md = [
    '# Plan',
    '',
    validBlock('1.1'),
    '',
    validBlock('1.2'),
    '',
  ].join('\n');
  await writeFile(path, md, 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(0);
  expect(cap.err.join('\n')).toBe('');
});

test('runPlanValidate returns 2 with hint when file has no yaml meta blocks', async () => {
  const path = join(workDir, 'empty.md');
  await writeFile(path, '# Plan\n\nNo yaml meta blocks here.\n', 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(2);
  expect(cap.err.join('\n')).toContain('no yaml meta blocks found');
  expect(cap.err.join('\n')).toContain(path);
});

test('runPlanValidate returns 2 and reports parser errors with line numbers', async () => {
  const path = join(workDir, 'malformed.md');
  const md = [
    '# Plan',
    '',
    '```yaml meta',
    'id: 1.1',
    'files: [unterminated',
    '  bad: yaml: : :',
    '```',
    '',
  ].join('\n');
  await writeFile(path, md, 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(2);
  const stderr = cap.err.join('\n');
  expect(stderr).toContain('parse:');
  expect(stderr).toContain('malformed.md');
});

test('runPlanValidate returns 2 and reports rule violations with task id', async () => {
  const path = join(workDir, 'bad-parallel.md');
  // Task 1.1 declares parallel_with = ['1.2'] but 1.2 does not exist anywhere → parallel_with_unknown.
  const md = [
    '# Plan',
    '',
    validBlock('1.1', { parallel_with: ['1.2'] }),
    '',
  ].join('\n');
  await writeFile(path, md, 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(2);
  const stderr = cap.err.join('\n');
  expect(stderr).toContain('1.1');
  expect(stderr).toContain('parallel_with_unknown');
});

test('runPlanStart prints the plan id and initial task tree', async () => {
  const path = join(workDir, 'plan.md');
  await writeFile(path, planFixture(path), 'utf8');

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url), 'http://127.0.0.1:4242');
    if (parsed.pathname === '/plans' && init?.method === 'POST') {
      expect(JSON.parse(String(init.body)) as { file_path: string }).toEqual({ file_path: path });
      return new Response(JSON.stringify({ plan_id: 'plan_123', status: 'running' }), { status: 201 });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };

  const lines: string[] = [];
  await runPlanStart({
    path,
    storageRoot: workDir,
    fetch,
    print: (line) => lines.push(line),
  });

  expect(requests[0]?.url).toContain('/plans');
  expect(lines[0]).toBe('plan_id: plan_123');
  expect(lines.join('\n')).toContain('[pending] 1.1 · project=penumbra');
  expect(lines.join('\n')).toContain('  [pending] 1.2 · project=penumbra');
});

test('runPlanList renders a table and forwards status filters', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url), 'http://127.0.0.1:4242');
    if (parsed.pathname === '/plans' && parsed.search === '') {
      return new Response(JSON.stringify({
        plans: [
          {
            plan_id: 'plan_123',
            file_path: '/tmp/plan-123.md',
            home_project: 'penumbra',
            registered_at: 1,
            status: 'running',
          },
        ],
      }), { status: 200 });
    }
    if (parsed.pathname === '/plans/plan_123') {
      return new Response(JSON.stringify(planRecord('/tmp/plan-123.md', 'running', 'plan_123')), { status: 200 });
    }
    if (parsed.pathname === '/plans' && parsed.search === '?status=running') {
      return new Response(JSON.stringify({
        plans: [
          {
            plan_id: 'plan_123',
            file_path: '/tmp/plan-123.md',
            home_project: 'penumbra',
            registered_at: 1,
            status: 'running',
          },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected ${parsed.pathname}${parsed.search}`);
  };

  const lines: string[] = [];
  await runPlanList({ storageRoot: workDir, fetch, print: (line) => lines.push(line) });
  const output = lines.join('\n');
  expect(output).toContain('plan_id');
  expect(output).toContain('home_project');
  expect(output).toContain('plan_123'.slice(0, 12));
  expect(output).toContain('running=1');

  const filtered: string[] = [];
  await runPlanList({ status: 'running', storageRoot: workDir, fetch, print: (line) => filtered.push(line) });
  expect(requests.some((req) => String(req.url).includes('/plans?status=running'))).toBe(true);
  expect(filtered.join('\n')).toContain('plan_123'.slice(0, 12));
});

test('runPlanStatus renders the plan task DAG', async () => {
  const path = join(workDir, 'status-plan.md');
  await writeFile(path, planFixture(path), 'utf8');

  const fetch = async (url: string | URL): Promise<Response> => {
    const parsed = new URL(String(url), 'http://127.0.0.1:4242');
    if (parsed.pathname === '/plans/plan_123') {
      return new Response(JSON.stringify(planRecord(path, 'running', 'plan_123')), { status: 200 });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };

  const lines: string[] = [];
  await runPlanStatus({
    id: 'plan_123',
    storageRoot: workDir,
    fetch,
    print: (line) => lines.push(line),
  });

  const output = lines.join('\n');
  expect(output).toContain('plan_id: plan_123');
  expect(output).toContain('[running] 1.1 · project=penumbra · board=task-board-1');
  expect(output).toContain('  [pending] 1.2 · project=penumbra · board=-');
});

test('runPlanStatus watch stops after the first poll when signaled', async () => {
  const path = join(workDir, 'watch-plan.md');
  await writeFile(path, planFixture(path), 'utf8');

  const controller = new AbortController();
  let polls = 0;
  const fetch = async (url: string | URL): Promise<Response> => {
    polls += 1;
    const parsed = new URL(String(url), 'http://127.0.0.1:4242');
    if (parsed.pathname === '/plans/plan_123') {
      controller.abort();
      return new Response(JSON.stringify(planRecord(path, 'running', 'plan_123')), { status: 200 });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };

  const lines: string[] = [];
  await runPlanStatus({
    id: 'plan_123',
    storageRoot: workDir,
    fetch,
    signal: controller.signal,
    pollIntervalMs: 1,
    print: (line) => lines.push(line),
    watch: true,
  });

  expect(polls).toBe(1);
  expect(lines.join('\n')).toContain('[running] 1.1 · project=penumbra · board=task-board-1');
});

test('runPlanCancel prints the cancelled running count', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url), 'http://127.0.0.1:4242');
    if (parsed.pathname === '/plans/plan_123/cancel' && init?.method === 'POST') {
      return new Response(JSON.stringify({ plan_id: 'plan_123', status: 'cancelled', cancelled_running_count: 1 }), { status: 200 });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };

  const lines: string[] = [];
  await runPlanCancel({
    id: 'plan_123',
    storageRoot: workDir,
    fetch,
    print: (line) => lines.push(line),
  });

  expect(requests[0]?.url).toContain('/plans/plan_123/cancel');
  expect(lines).toEqual(['cancelled 1']);
});
