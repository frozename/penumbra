import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSpecSchema } from '../../src/schema.js';
import { taskOutput } from '../../src/outputs/task.js';

test('task output schema parses minimal config and rejects missing prompt', () => {
  const parsed = WorkflowSpecSchema.parse({
    name: 'task-wf',
    description: 'file a task',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [{ kind: 'task', prompt: 'do the thing' }],
    run: { kind: 'ts-function' },
  });
  expect(parsed.output[0]).toEqual({ kind: 'task', prompt: 'do the thing' });

  const missingPrompt = WorkflowSpecSchema.safeParse({
    name: 'task-wf',
    description: 'file a task',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [{ kind: 'task' }],
    run: { kind: 'ts-function' },
  });
  expect(missingPrompt.success).toBe(false);
});

test('taskOutput resolves templates and posts the workflow task payload', async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), 'task-out-'));
  writeFileSync(join(root, 'port'), '54321');
  writeFileSync(join(root, 'token'), 'test-token');
  try {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    globalThis.fetch = (async (input, init) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await taskOutput(
      {
        kind: 'task',
        prompt: 'investigate {{file_path}}',
        acceptance_criteria: 'confirm {{file_path}} is fixed',
        priority: 'high',
        eligibility: { required_tags: ['{{project}}'] },
        review_eligibility: { min_tier: '{{project}}' },
      },
      {
        workflow: { name: 'task-wf', origin: undefined },
        now: () => new Date('2026-05-05T08:00:00Z'),
        project: 'penumbra',
        sessionStart: '2026-05-05T07:00:00Z',
        tz: 'UTC',
        filePath: 'src/foo.ts',
        storageRoot: root,
      } as any,
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('http://127.0.0.1:54321/tasks');
    expect(captured!.init?.method).toBe('POST');
    const headers = captured!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
    const body = JSON.parse(String(captured!.init?.body));
    expect(body.prompt).toBe('investigate src/foo.ts');
    expect(body.acceptance_criteria).toBe('confirm src/foo.ts is fixed');
    expect(body.priority).toBe('high');
    expect(body.created_by_kind).toBe('workflow');
    expect(body.created_by_id).toBe('task-wf');
    expect(body.origin).toBeNull();
    expect(body.eligibility.required_tags).toEqual(['penumbra']);
    expect(body.review_eligibility.min_tier).toBe('penumbra');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('taskOutput passes through task_kind=orchestrate and bounds', async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), 'task-out-'));
  writeFileSync(join(root, 'port'), '54321');
  writeFileSync(join(root, 'token'), 'test-token');
  try {
    let capturedBody: any = null;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await taskOutput(
      {
        kind: 'task',
        prompt: 'orchestrate this',
        task_kind: 'orchestrate',
        eligibility: { allow_agents: ['claude-acp-sonnet'] },
        bounds: { wall_clock_ms: 60_000, cost_cents: 50, max_sub_dispatches: 5 },
      },
      {
        workflow: { name: 'task-wf', origin: undefined },
        now: () => new Date('2026-05-05T08:00:00Z'),
        project: 'penumbra',
        sessionStart: '2026-05-05T07:00:00Z',
        tz: 'UTC',
        storageRoot: root,
      } as any,
    );

    expect(capturedBody.kind).toBe('orchestrate');
    expect(capturedBody.bounds).toEqual({
      wall_clock_ms: 60_000,
      cost_cents: 50,
      max_sub_dispatches: 5,
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('taskOutput omits kind/bounds when not specified', async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), 'task-out-'));
  writeFileSync(join(root, 'port'), '54321');
  writeFileSync(join(root, 'token'), 'test-token');
  try {
    let capturedBody: any = null;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await taskOutput(
      { kind: 'task', prompt: 'no orchestrate' },
      {
        workflow: { name: 'task-wf', origin: undefined },
        now: () => new Date('2026-05-05T08:00:00Z'),
        project: 'penumbra',
        sessionStart: '2026-05-05T07:00:00Z',
        tz: 'UTC',
        storageRoot: root,
      } as any,
    );

    expect(capturedBody.kind).toBeUndefined();
    expect(capturedBody.bounds).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('taskOutput propagates workflow origin', async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), 'task-out-'));
  writeFileSync(join(root, 'port'), '54321');
  writeFileSync(join(root, 'token'), 'test-token');
  try {
    let capturedBody: any = null;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await taskOutput(
      { kind: 'task', prompt: 'do it' },
      {
        workflow: { name: 'task-wf', origin: 'wf-test' },
        now: () => new Date('2026-05-05T08:00:00Z'),
        project: 'penumbra',
        sessionStart: '2026-05-05T07:00:00Z',
        tz: 'UTC',
        storageRoot: root,
      } as any,
    );

    expect(capturedBody.origin).toBe('wf-test');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
