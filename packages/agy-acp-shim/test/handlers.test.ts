import { describe, expect, it } from 'bun:test';
import { makeHandlers } from '../src/handlers.js';
import type { AgyHandle } from '../src/handlers.js';

function mockSpawnAgy(lines: string[]) {
  return (opts: { onLine: (l: string) => void }): AgyHandle => {
    const exited = new Promise<number>((res) => {
      Promise.resolve().then(() => {
        for (const l of lines) opts.onLine(l);
        res(0);
      });
    });
    return { exited, kill: () => {} };
  };
}

describe('initialize', () => {
  it('returns protocolVersion and empty capabilities', async () => {
    const { handleInitialize } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const result = await handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'penumbra', version: '1.0.0' },
    });
    expect(result.protocolVersion).toBe(1);
    // no tool capabilities advertised
    expect(result.capabilities?.terminal).toBeFalsy();
    expect(result.capabilities?.fs).toBeFalsy();
  });
});

describe('session/new', () => {
  it('returns a non-empty session ID string', async () => {
    const { handleSessionNew } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const result = await handleSessionNew({});
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('returns a different ID on each call', async () => {
    const { handleSessionNew } = makeHandlers({ spawnAgy: null as any, notify: () => {} });
    const a = await handleSessionNew({});
    const b = await handleSessionNew({});
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('session/prompt (mocked agy)', () => {
  it('emits message.part.delta notifications for each agy output line', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { handleSessionPrompt } = makeHandlers({
      spawnAgy: mockSpawnAgy(['hello', 'world']) as any,
      notify: (method, params) => notifications.push({ method, params }),
    });

    await handleSessionPrompt({
      sessionId: 's1',
      parts: [{ type: 'text', text: 'hi' }],
    });

    const deltas = notifications.filter((n) => n.method === 'session/update');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a done notification after agy exits', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const { handleSessionPrompt } = makeHandlers({
      spawnAgy: mockSpawnAgy(['pong']) as any,
      notify: (method, params) => notifications.push({ method, params }),
    });

    await handleSessionPrompt({
      sessionId: 's1',
      parts: [{ type: 'text', text: 'ping' }],
    });

    expect(notifications.some((n) => n.method === 'done')).toBe(true);
  });
});
