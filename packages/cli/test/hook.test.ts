import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapClaudeCodeEvent, runHook } from '../src/commands/hook.js';

test('mapClaudeCodeEvent produces an agent-prompt T0 event for UserPromptSubmit', () => {
  const ev = mapClaudeCodeEvent({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'help me refactor this file',
    session_id: 'cc-session-1',
    cwd: '/Volumes/WorkSSD/repos/personal/myproj',
  }, { project: null, sessionId: null });
  expect(ev).not.toBeNull();
  expect(ev!.source).toBe('claude-code');
  expect(ev!.event_type).toBe('agent-prompt');
  expect(ev!.lane).toBe('cli-subscription');
  expect(ev!.session_id).toBe('cc-session-1');
  expect(ev!.payload_summary).toBe('help me refactor this file');
});

test('mapClaudeCodeEvent produces an agent-tool-use T0 event for PreToolUse', () => {
  const ev = mapClaudeCodeEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls', description: 'list dir' },
    session_id: 'cc-session-1',
  }, { project: 'myproj', sessionId: null });
  expect(ev).not.toBeNull();
  expect(ev!.event_type).toBe('agent-tool-use');
  expect(ev!.project_id).toBe('myproj');
  expect(ev!.payload_summary).toMatch(/^Bash/);
});

test('mapClaudeCodeEvent skips unknown hook events', () => {
  const ev = mapClaudeCodeEvent({ hook_event_name: 'UnknownEvent' }, { project: null, sessionId: null });
  expect(ev).toBeNull();
});

test('runHook posts to /observations on the live daemon', async () => {
  let received: { headers: Headers; body: any } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { headers: req.headers, body: await req.json() };
      return Response.json({ event_id: 'cc-1' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'penumbra-hook-test-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const exit = await runHook({
    storageRoot: root,
    rawEvent: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hi',
      session_id: 's-1',
    }),
    project: null,
    sessionId: null,
  });
  try {
    expect(exit).toBe(0);
    expect(received).not.toBeNull();
    expect(received!.headers.get('authorization')).toBe('Bearer tk');
    expect(received!.body.event_type).toBe('agent-prompt');
    expect(received!.body.source).toBe('claude-code');
  } finally { server.stop(true); }
});

test('runHook returns 0 (best-effort) when the daemon is unreachable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-hook-test-'));
  writeFileSync(join(root, 'port'), '1\n'); // unlikely-bound port
  writeFileSync(join(root, 'token'), 'tk\n');

  const exit = await runHook({
    storageRoot: root,
    rawEvent: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
    project: null,
    sessionId: null,
  });
  expect(exit).toBe(0);
});
