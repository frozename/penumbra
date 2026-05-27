import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openInvocationSink, type InvocationRow } from '../src/invocation-sink.js';

const EXPECTED_KEYS = [
  'args_bytes',
  'duration_ms',
  'error_kind',
  'ok',
  'origin',
  'result_bytes',
  'ts',
  'tool',
].sort();

let dir = '';

function makeRow(overrides: Partial<InvocationRow> = {}): InvocationRow {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'test_tool',
    origin: 'mcp',
    args_bytes: 10,
    result_bytes: 20,
    duration_ms: 5,
    ok: true,
    error_kind: null,
    ...overrides,
  };
}

describe('invocation sink', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inv-sink-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a single JSONL line and flushes on close', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    sink.write(makeRow());
    await sink.close();

    const text = readFileSync(filePath, 'utf8').trim();
    expect(text.length).toBeGreaterThan(0);
    const row = JSON.parse(text);
    expect(row.tool).toBe('test_tool');
  });

  it('double close does not throw', async () => {
    const sink = openInvocationSink(join(dir, 'inv.jsonl'));
    await sink.close();
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it('creates parent directories if missing', async () => {
    const nestedPath = join(dir, 'a', 'b', 'inv.jsonl');
    const sink = openInvocationSink(nestedPath);
    sink.write(makeRow());
    await sink.close();

    expect(existsSync(nestedPath)).toBe(true);
  });

  it('write after close is silent no-op (does not throw)', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    await sink.close();
    expect(() => sink.write(makeRow())).not.toThrow();
  });

  it('security: file is mode 0o600', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    sink.write(makeRow());
    await sink.close();

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('security: dir is mode 0o700', async () => {
    const filePath = join(dir, 'private', 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    sink.write(makeRow());
    await sink.close();

    expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
  });

  it('security: schema keys are exactly the documented 8 fields', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    sink.write(makeRow());
    await sink.close();

    const row = JSON.parse(readFileSync(filePath, 'utf8').trim());
    expect(Object.keys(row).sort()).toEqual(EXPECTED_KEYS);
  });

  it('security: daily byte cap drops silently', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath, { maxBytesPerDay: 100 });

    for (let i = 0; i < 10; i += 1) {
      sink.write(makeRow({ ts: `2026-01-01T00:00:0${i}.000Z`, tool: `tool_${i}` }));
    }
    await sink.close();

    expect(statSync(filePath).size).toBeLessThanOrEqual(100);
  });
});
