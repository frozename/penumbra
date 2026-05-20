import { describe, expect, it } from 'bun:test';
import { makeHandlers } from '../src/handlers.js';

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
