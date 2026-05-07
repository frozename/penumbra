import { describe, expect, mock, test } from 'bun:test';
import { createMcpToolInvoker } from '../../src/tools/registry.js';
import { DaemonClient } from '../../src/daemon-client.js';

function makeDaemonStub(handlers: Partial<Record<string, (...args: any[]) => Promise<unknown>>>) {
  const daemon = {
    recall: handlers.recall ?? mock(async () => ({ ok: true })),
    search: handlers.search ?? mock(async () => ({ ok: true })),
    getObservations: handlers.getObservations ?? mock(async () => ({ ok: true })),
    observe: handlers.observe ?? mock(async () => ({ ok: true })),
  } as unknown as DaemonClient;

  return daemon;
}

describe('createMcpToolInvoker', () => {
  test('returns the handler result for read-only tools', async () => {
    const daemon = makeDaemonStub({
      search: mock(async () => ({ ok: true })),
    });

    const invoke = createMcpToolInvoker(daemon);
    const out = await invoke('memory.search', { query: 'q' });

    expect(out).toEqual({ ok: true });
  });

  test('rejects write tools in recall context', async () => {
    const observe = mock(async () => {
      throw new Error('should not be invoked');
    });
    const daemon = makeDaemonStub({ observe });
    const invoke = createMcpToolInvoker(daemon);

    await expect(invoke('memory.observe', { event_type: 'x' })).rejects.toThrow(
      /not allowed in recall context/,
    );
    expect(observe).not.toHaveBeenCalled();
  });

  test('rejects unknown tools', async () => {
    const daemon = makeDaemonStub({});
    const invoke = createMcpToolInvoker(daemon);

    await expect(invoke('no.such.tool', {})).rejects.toThrow(/unknown tool/);
  });
});
