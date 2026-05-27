import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInvocationSink, type InvocationSink } from '../src/invocation-sink.js';
import * as registry from '../src/invocation-sink-registry.js';
import { wrapHandler, type AnyHandler } from '../src/instrumentation.js';

let tempDirs: string[] = [];

function makeTempDir(prefix = 'mcp-wrap-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function withSink(): { path: string; sink: InvocationSink } {
  const dir = makeTempDir();
  const path = join(dir, 'inv.jsonl');
  const sink = openInvocationSink(path);
  spyOn(registry, 'getSink').mockReturnValue(sink);
  return { path, sink };
}

function readRows(path: string): any[] {
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) {
    return [];
  }
  return text.split('\n').map((line) => JSON.parse(line));
}

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('wrapHandler', () => {
  it('logs a successful call (origin from _meta, fields correct)', async () => {
    const { path, sink } = withSink();
    const handler = wrapHandler('my_tool', async () => ({ result: 'ok' }), { enabled: true });

    await handler({ x: 1 }, { _meta: { origin: 'claude-code' } });
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('my_tool');
    expect(rows[0].origin).toBe('claude-code');
    expect(rows[0].ok).toBe(true);
    expect(rows[0].error_kind).toBeNull();
    expect(typeof rows[0].duration_ms).toBe('number');
    expect(rows[0].args_bytes).toBe(JSON.stringify({ x: 1 }).length);
    expect(rows[0].result_bytes).toBe(JSON.stringify({ result: 'ok' }).length);
  });

  it('resolves origin per-call via header (not closure-captured)', async () => {
    const { path, sink } = withSink();
    const handler = wrapHandler('t', async () => ({}), { enabled: true });

    await handler({}, { requestInfo: { headers: { 'x-penumbra-origin': 'caller-A' } } });
    await handler({}, { requestInfo: { headers: { 'x-penumbra-origin': 'caller-B' } } });
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(2);
    expect(rows[0].origin).toBe('caller-A');
    expect(rows[1].origin).toBe('caller-B');
  });

  it('defaults origin to "unknown" when extra has no origin signal', async () => {
    const { path, sink } = withSink();
    const handler = wrapHandler('t', async () => ({}), { enabled: true });

    await handler({}, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('unknown');
  });

  it('logs a failing call with constructor-name error_kind and rethrows original error', async () => {
    const { path, sink } = withSink();
    class TimeoutError extends Error {}
    const handler = wrapHandler('bad', async () => {
      throw new TimeoutError('oops');
    }, { enabled: true });

    await expect(handler({}, {})).rejects.toThrow('oops');
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error_kind).toBe('TimeoutError');
  });

  it('records args_bytes = -1 for circular args', async () => {
    const { path, sink } = withSink();
    const handler = wrapHandler('t', async () => ({}), { enabled: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await handler(circular, {});
    await sink.close();

    const rows = readRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].args_bytes).toBe(-1);
  });

  it('is a no-op when opts.enabled is false (raw handler returned)', async () => {
    const raw: AnyHandler = async () => ({ value: 42 });
    const wrapped = wrapHandler('t', raw, { enabled: false });

    expect(wrapped).toBe(raw);
    await expect(wrapped({ q: 1 }, {})).resolves.toEqual({ value: 42 });
  });

  it('swallows sink write errors and still returns handler result', async () => {
    spyOn(registry, 'getSink').mockReturnValue({
      write: () => {
        throw new Error('disk full');
      },
      close: async () => {},
    });
    const handler = wrapHandler('t', async () => ({ ok: true }), { enabled: true });

    await expect(handler({}, {})).resolves.toEqual({ ok: true });
  });
});
