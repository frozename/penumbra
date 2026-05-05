import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claudeCodeEventToLifecycle,
  defaultLifecycleForwardFn,
  runLifecycleForward,
} from '../../src/commands/hook.js';

test('runLifecycleForward calls forwardFn with kind=lifecycle and the given event', async () => {
  const calls: Array<{ event: string; toolName: string | null | undefined }> = [];
  const fakeForward = async (event: { kind: 'lifecycle'; event: string; hookContext?: { tool_name?: string | null } }) => {
    calls.push({ event: event.event, toolName: event.hookContext?.tool_name });
  };
  await runLifecycleForward({ event: 'pre-compact', cwd: '/tmp', forwardFn: fakeForward });
  await runLifecycleForward({
    event: 'stop',
    cwd: '/tmp',
    forwardFn: fakeForward,
    hookContext: { tool_name: 'Edit' },
  });
  await runLifecycleForward({ event: 'session-start', cwd: '/tmp', forwardFn: fakeForward });
  expect(calls).toEqual([
    { event: 'pre-compact', toolName: undefined },
    { event: 'stop', toolName: 'Edit' },
    { event: 'session-start', toolName: undefined },
  ]);
});

const realFetch = globalThis.fetch;

function withMockedFetch<T>(impl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}

function withCapturedStdout<T>(fn: () => Promise<T>): Promise<{ result: T; chunks: string[] }> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = ((data: any) => {
    chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then((result) => ({ result, chunks }))
    .finally(() => {
      (process.stdout as any).write = origWrite;
    });
}

function makeStorageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hook-life-'));
  writeFileSync(join(root, 'port'), '12345');
  writeFileSync(join(root, 'token'), 'test-token');
  return root;
}

test('defaultLifecycleForwardFn emits SessionStart envelope when daemon returns additionalContext', async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ matched: ['x'], additionalContext: 'PROBE_CONTEXT' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { chunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = await defaultLifecycleForwardFn(root, '/tmp');
        await fn({ kind: 'lifecycle', event: 'session-start' });
      }),
    );
    const written = chunks.join('');
    expect(written).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'PROBE_CONTEXT',
        },
      }) + '\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaultLifecycleForwardFn maps pre-compact / stop to PreCompact / Stop event names', async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ matched: [], additionalContext: 'X' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { chunks: preChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = await defaultLifecycleForwardFn(root, '/tmp');
        await fn({ kind: 'lifecycle', event: 'pre-compact' });
      }),
    );
    expect(preChunks.join('')).toContain('"hookEventName":"PreCompact"');

    const { chunks: stopChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = await defaultLifecycleForwardFn(root, '/tmp');
        await fn({ kind: 'lifecycle', event: 'stop' });
      }),
    );
    expect(stopChunks.join('')).toContain('"hookEventName":"Stop"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claudeCodeEventToLifecycle maps Claude Code hook event names to lifecycle events', () => {
  expect(claudeCodeEventToLifecycle('SessionStart')).toBe('session-start');
  expect(claudeCodeEventToLifecycle('PreCompact')).toBe('pre-compact');
  expect(claudeCodeEventToLifecycle('Stop')).toBe('stop');
  expect(claudeCodeEventToLifecycle('UserPromptSubmit')).toBe('user-prompt-submit');
  expect(claudeCodeEventToLifecycle('PostToolUse')).toBe('post-tool-use');
  expect(claudeCodeEventToLifecycle('PreToolUse')).toBeNull();
  expect(claudeCodeEventToLifecycle(undefined)).toBeNull();
  expect(claudeCodeEventToLifecycle(null)).toBeNull();
});

test('defaultLifecycleForwardFn maps user-prompt-submit / post-tool-use to UserPromptSubmit / PostToolUse event names', async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = async (_input, init) =>
      new Response(JSON.stringify({ matched: [], additionalContext: 'X' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { chunks: upsChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = await defaultLifecycleForwardFn(root, '/tmp');
        await fn({ kind: 'lifecycle', event: 'user-prompt-submit' });
      }),
    );
    expect(upsChunks.join('')).toContain('"hookEventName":"UserPromptSubmit"');

    const { chunks: ptuChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = await defaultLifecycleForwardFn(root, '/tmp');
        await fn({ kind: 'lifecycle', event: 'post-tool-use' });
      }),
    );
    expect(ptuChunks.join('')).toContain('"hookEventName":"PostToolUse"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaultLifecycleForwardFn forwards hookContext.tool_name in the request body', async () => {
  const root = makeStorageRoot();
  try {
    let requestBody: any = null;
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? 'null'));
      return new Response(JSON.stringify({ matched: [], additionalContext: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await withMockedFetch(fakeFetch, async () => {
      const fn = await defaultLifecycleForwardFn(root, '/tmp');
      await fn({ kind: 'lifecycle', event: 'post-tool-use', hookContext: { tool_name: 'Edit' } });
    });

    expect(requestBody).toEqual({
      event: {
        kind: 'lifecycle',
        event: 'post-tool-use',
        hookContext: { tool_name: 'Edit' },
      },
      cwd: '/tmp',
      hookContext: { tool_name: 'Edit' },
      session_id: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaultLifecycleForwardFn writes nothing when additionalContext is null/empty', async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ matched: [], additionalContext: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { chunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = await defaultLifecycleForwardFn(root, '/tmp');
        await fn({ kind: 'lifecycle', event: 'session-start' });
      }),
    );
    expect(chunks.join('')).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
