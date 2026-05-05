import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTaskCancel,
  runTaskList,
  runTaskNew,
  runTaskShow,
  runTaskWatch,
} from '../../src/commands/task.js';

let storageRoot = '';

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-task-cli-'));
  writeFileSync(join(storageRoot, 'port'), '4242\n');
  writeFileSync(join(storageRoot, 'token'), 'tok\n');
});

afterEach(() => {
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

test('task new/list/show/cancel/list filter', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let taskId = '';
  let taskStatus = 'pending';
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url), 'http://127.0.0.1:4242');
    const pathname = `${parsed.pathname}${parsed.search}`;
    if (pathname === '/tasks' && init?.method === 'POST') {
      taskId = 'task_123';
      return new Response(JSON.stringify({ task_id: taskId }), { status: 201 });
    }
    if (pathname === `/tasks/${taskId}?include=lease,events` || pathname === `/tasks/${taskId}`) {
      return new Response(JSON.stringify({
        id: taskId,
        created_at: 1,
        updated_at: 1,
        created_by_kind: 'human',
        created_by_id: 'cli',
        parent_task_id: null,
        kind: 'work',
        priority: 'high',
        prompt: 'test',
        acceptance_criteria: null,
        expected_artifacts: null,
        eligibility: {},
        review_eligibility: null,
        requires_review: false,
        status: taskStatus,
        result_summary: null,
        result_artifacts: null,
        failure_reason: null,
        chain_id: null,
        origin: 'cli',
      }), { status: 200 });
    }
    if (pathname === `/tasks/${taskId}/cancel` && init?.method === 'POST') {
      taskStatus = 'cancelled';
      return new Response(JSON.stringify({ task_id: taskId }), { status: 200 });
    }
    if (pathname.startsWith('/tasks') && init?.method !== 'POST' && !pathname.endsWith('/cancel')) {
      const task = {
        id: taskId,
        created_at: 1,
        updated_at: 1,
        created_by_kind: 'human',
        created_by_id: 'cli',
        parent_task_id: null,
        kind: 'work',
        priority: 'high',
        prompt: 'test',
        acceptance_criteria: null,
        expected_artifacts: null,
        eligibility: {},
        review_eligibility: null,
        requires_review: false,
        status: taskStatus,
        result_summary: null,
        result_artifacts: null,
        failure_reason: null,
        chain_id: null,
        origin: 'cli',
      };
      return new Response(JSON.stringify({ tasks: taskStatus === 'pending' ? [task] : [] }), { status: 200 });
    }
    throw new Error(`unexpected ${pathname}`);
  };

  const created: string[] = [];
  await runTaskNew({
    prompt: 'test',
    priority: 'high',
    storageRoot,
    fetch,
    print: (line) => created.push(line),
  });
  expect(created).toEqual(['task_123']);

  const listed: string[] = [];
  await runTaskList({ json: true, storageRoot, fetch, print: (line) => listed.push(line) });
  const listBody = JSON.parse(listed.join('\n')) as { tasks: Array<{ id: string; priority: string }> };
  expect(listBody.tasks[0]?.id).toBe(taskId);
  expect(listBody.tasks[0]?.priority).toBe('high');

  const mine: string[] = [];
  await runTaskList({ mine: true, json: true, storageRoot, fetch, print: (line) => mine.push(line) });
  expect(requests.some((req) => String(req.url).includes('origin=cli'))).toBe(true);

  const shown: string[] = [];
  await runTaskShow({ id: taskId, json: true, storageRoot, fetch, print: (line) => shown.push(line) });
  expect(JSON.parse(shown.join('\n'))).toEqual(expect.objectContaining({ id: taskId }));

  await runTaskCancel({ id: taskId, storageRoot, fetch });

  const filtered: string[] = [];
  await runTaskList({ status: 'pending', json: true, storageRoot, fetch, print: (line) => filtered.push(line) });
  expect(JSON.parse(filtered.join('\n')).tasks.some((task: { id: string }) => task.id === taskId)).toBe(false);
});

test('task watch prints filed events', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(': ok\n\n'));
      setTimeout(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: 'filed', task_id: 'task_abc', actor: 'cli', ts: '2026-05-05T12:00:00.000Z' })}\n\n`));
        controller.close();
      }, 10);
    },
  });
  const lines: string[] = [];
  await runTaskWatch({
    storageRoot,
    fetch: async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    print: (line) => lines.push(line),
  });
  expect(lines).toContain('[2026-05-05T12:00:00.000Z] filed task=task_abc actor=cli');
});
