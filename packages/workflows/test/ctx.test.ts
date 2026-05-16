import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChainStartRequest, Services } from '@penumbra/core';
import { buildWorkflowCtx } from '../src/ctx.js';

function fakeServices(): Services {
  return {
    handoffReader: {
      getRootForConversation: () => null,
      getLatestForConversation: () => null,
    },
    chainReader: {
      getResponses: () => [],
    },
  } as unknown as Services;
}

test('dispatch returns ids from chain.start payload', async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  const out = await ctx.dispatch({ agent: 'codex', message: 'run this', task_type: 'implementer' });
  expect(out).toEqual({ conversation_id: 'conv-1', handoff_id: 'hand-1' });
  expect(captured?.initial_agent).toBe('codex');
  expect(captured?.project_id).toBe('proj-1');
  expect(captured?.task_type).toBe('implementer');
});

test('dispatch threads deps.project into chainStart req.project_id', async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'sirius',
    agentchatConfig: {},
    workflowRunId: 'wfrun-test-uuid',
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-2', handoff_id: 'hand-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  const out = await ctx.dispatch({ agent: 'codex', message: 'review this', task_type: 'implementer' });
  expect(out).toEqual({ conversation_id: 'conv-2', handoff_id: 'hand-2' });
  expect(captured?.project_id).toBe('sirius');
});

test('dispatch uses per-call project_id override over deps.project', async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'sirius',
    agentchatConfig: {},
    workflowRunId: 'wfrun-test-uuid',
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-3', handoff_id: 'hand-3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: 'codex',
    message: 'noop',
    task_type: 'implementer',
    project_id: 'novaflow',
  });
  expect(out).toEqual({ conversation_id: 'conv-3', handoff_id: 'hand-3' });
  expect(captured?.project_id).toBe('novaflow');
});

test('dispatch stamps workflow dispatch_kind on chainStart requests', async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'sirius',
    agentchatConfig: {},
    workflowRunId: 'wfrun-test-uuid',
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-4a', handoff_id: 'hand-4a' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  const out = await ctx.dispatch({
    agent: 'codex',
    message: 'workflow hop',
    task_type: 'implementer',
  });
  expect(out).toEqual({ conversation_id: 'conv-4a', handoff_id: 'hand-4a' });
  expect(captured?.dispatch_kind).toBe('workflow');
  expect(captured?.workflow_run_id).toBe('wfrun-test-uuid');
});

test('dispatch omits project_id when deps.project is falsy', async () => {
  let captured: ChainStartRequest | null = null;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: '',
    agentchatConfig: {},
    chainStart: (input) => {
      captured = input;
      return Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-4', handoff_id: 'hand-4' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  const out = await ctx.dispatch({ agent: 'codex', message: 'noop', task_type: 'implementer' });
  expect(out).toEqual({ conversation_id: 'conv-4', handoff_id: 'hand-4' });
  expect(captured?.project_id).toBeUndefined();
});

test('awaitChain returns timeout when terminal state never arrives', async () => {
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    readChainStatus: async () => ({
      terminal: false,
      status: 'failed',
      final_agent: null,
      response_text: null,
    }),
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  const out = await ctx.awaitChain('conv-1', { timeoutMs: 1 });
  expect(out.status).toBe('timeout');
  expect(out.final_agent).toBeNull();
  expect(out.response_text).toBeNull();
});

test('awaitChain uses exponential backoff up to a 2000ms cap', async () => {
  const sleepCalls: number[] = [];
  let nowMs = 0;
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    readChainStatus: async () => ({
      terminal: false,
      status: 'failed',
      final_agent: null,
      response_text: null,
    }),
    sleep: async (ms) => {
      sleepCalls.push(ms);
      nowMs += ms;
    },
    now: () => nowMs,
  });

  const out = await ctx.awaitChain('conv-1', { timeoutMs: 10000 });
  expect(out.status).toBe('timeout');
  expect(sleepCalls.length).toBeGreaterThan(8);
  expect(sleepCalls[0]).toBe(200);
  expect(sleepCalls[1]).toBe(300);
  expect(sleepCalls[2]).toBe(450);
  expect(sleepCalls[3]).toBe(675);
  expect(sleepCalls[4]).toBeCloseTo(1012.5, 5);
  expect(sleepCalls[sleepCalls.length - 1]).toBe(2000);
});

test('awaitChain returns failed when handoff completed but zero responses', async () => {
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => [],
      },
    } as unknown as Services,
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });

  const out = await ctx.awaitChain('conv-1', { timeoutMs: 10 });
  expect(out.status).toBe('failed');
  expect(out.final_agent).toBeNull();
  expect(out.response_text).toBeNull();
});

test('awaitChain waits for late agent-response stamped after handoff goes terminal', async () => {
  let getResponsesCalls = 0;
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => {
          getResponsesCalls += 1;
          if (getResponsesCalls < 4) return [];
          return [{ agent: 'codex', text: 'late review body that arrived after terminal' }];
        },
      },
    } as unknown as Services,
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    pollIntervalMs: 1,
  });

  const out = await ctx.awaitChain('conv-1', { timeoutMs: 5000, lateResponseGraceMs: 1000 });
  expect(out.status).toBe('completed');
  expect(out.final_agent).toBe('codex');
  expect(out.response_text).toBe('late review body that arrived after terminal');
  expect(getResponsesCalls).toBeGreaterThanOrEqual(4);
});

test('awaitChain returns completed when handoff completed and response is present', async () => {
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => [{ agent: 'codex', text: 'all good' }],
      },
    } as unknown as Services,
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });

  const out = await ctx.awaitChain('conv-1', { timeoutMs: 10 });
  expect(out.status).toBe('completed');
  expect(out.final_agent).toBe('codex');
  expect(out.response_text).toBe('all good');
});

test('awaitChain prefers terminal root handoff over later failed child handoff', async () => {
  const ctx = buildWorkflowCtx({
    services: {
      handoffReader: {
        getRootForConversation: () => ({
          status: 'completed',
          resolved_at: new Date().toISOString(),
        }),
        getLatestForConversation: () => ({
          status: 'failed',
          resolved_at: new Date().toISOString(),
        }),
      },
      chainReader: {
        getResponses: () => [{ agent: 'claude', text: 'authoritative root response' }],
      },
    } as unknown as Services,
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });

  const out = await ctx.awaitChain('conv-1', { timeoutMs: 10 });
  expect(out.status).toBe('completed');
  expect(out.final_agent).toBe('claude');
  expect(out.response_text).toBe('authoritative root response');
});

test('fileWrite resolves storage-relative paths and returns written path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfctx-'));
  try {
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd: join(root, 'repo'),
      storageRoot: join(root, 'storage'),
      project: 'proj-1',
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    const written = await ctx.fileWrite('notes/out.txt', 'hello');
    const expected = resolve(join(root, 'storage', 'notes/out.txt'));
    expect(written).toBe(realpathSync(expected));
    expect(readFileSync(realpathSync(expected), 'utf8')).toBe('hello');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fileWrite resolves ./ paths from cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfctx-cwd-'));
  try {
    const cwd = join(root, 'repo');
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd,
      storageRoot: join(root, 'storage'),
      project: 'proj-1',
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    const written = await ctx.fileWrite('./report.md', '# hi');
    const expected = resolve(join(cwd, 'report.md'));
    expect(written).toBe(realpathSync(expected));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fileWrite allows absolute paths inside cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfctx-abs-cwd-'));
  try {
    const cwd = join(root, 'repo');
    const storageRoot = join(root, 'storage');
    const target = resolve(join(cwd, 'inside', 'allowed.txt'));
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd,
      storageRoot,
      project: 'proj-1',
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    const written = await ctx.fileWrite(target, 'ok');
    expect(written).toBe(realpathSync(target));
    expect(readFileSync(realpathSync(target), 'utf8')).toBe('ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fileWrite rejects absolute paths outside allowed roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfctx-abs-outside-'));
  try {
    const cwd = join(root, 'repo');
    const storageRoot = join(root, 'storage');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'wfctx-outside-root-'));
    const outsidePath = resolve(join(outsideRoot, 'outside.txt'));
    const ctx = buildWorkflowCtx({
      services: fakeServices(),
      cwd,
      storageRoot,
      project: 'proj-1',
      agentchatConfig: {},
      chainStart: () =>
        Promise.resolve(
          new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    await expect(ctx.fileWrite(outsidePath, 'nope')).rejects.toThrow('fileWrite path outside allowed roots');
    rmSync(outsideRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ctx exposes args passed to buildWorkflowCtx', () => {
  const args = { base_ref: 'main', target_ref: 'HEAD', timeout_ms: 1234 };
  const ctx = buildWorkflowCtx({
    services: fakeServices(),
    cwd: '/tmp/cwd',
    storageRoot: '/tmp/storage',
    project: 'proj-1',
    agentchatConfig: {},
    args,
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: 'conv-1', handoff_id: 'hand-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });

  expect(ctx.args).toEqual(args);
});
