import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  expect(captured?.project_id).toBeUndefined();
  expect(captured?.task_type).toBe('implementer');
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
    expect(written).toBe(expected);
    expect(readFileSync(expected, 'utf8')).toBe('hello');
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
    expect(written).toBe(expected);
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
