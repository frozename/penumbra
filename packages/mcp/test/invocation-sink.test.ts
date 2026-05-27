import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { closeWriteStream, openInvocationSink, type InvocationRow } from '../src/invocation-sink.js';

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

  it('security: extra fields on the row are not serialized (TS structural typing erased at runtime)', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    const polluted = {
      ...makeRow(),
      raw_input_json: { secret: 'do not log' },
      result_payload: 'must not leak',
    } as unknown as InvocationRow;
    sink.write(polluted);
    await sink.close();

    const text = readFileSync(filePath, 'utf8').trim();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('must not leak');
    expect(text).not.toContain('raw_input_json');
    expect(text).not.toContain('result_payload');
    const row = JSON.parse(text);
    expect(Object.keys(row).sort()).toEqual(EXPECTED_KEYS);
  });

  it('security: pre-existing file with loose mode is hardened to 0o600 on open', async () => {
    const filePath = join(dir, 'inv.jsonl');
    writeFileSync(filePath, '{"ts":"prev","tool":"prev","origin":"prev","args_bytes":0,"result_bytes":0,"duration_ms":0,"ok":true,"error_kind":null}\n');
    chmodSync(filePath, 0o644);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);

    const sink = openInvocationSink(filePath);
    await sink.close();

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('security: pre-existing parent directory is not chmod-mutated', async () => {
    const sharedDir = join(dir, 'shared');
    mkdirSync(sharedDir, { mode: 0o755 });
    chmodSync(sharedDir, 0o755);
    expect(statSync(sharedDir).mode & 0o777).toBe(0o755);

    const sink = openInvocationSink(join(sharedDir, 'inv.jsonl'));
    await sink.close();

    expect(statSync(sharedDir).mode & 0o777).toBe(0o755);
  });

  it('security: only newly-created ancestor segments are chmod-hardened', async () => {
    const sharedDir = join(dir, 'shared');
    mkdirSync(sharedDir, { mode: 0o755 });
    chmodSync(sharedDir, 0o755);
    const sinkDir = join(sharedDir, 'newroot', 'inv');
    const filePath = join(sinkDir, 'inv.jsonl');

    const sink = openInvocationSink(filePath);
    await sink.close();

    expect(statSync(sharedDir).mode & 0o777).toBe(0o755);
    expect(statSync(join(sharedDir, 'newroot')).mode & 0o777).toBe(0o700);
    expect(statSync(sinkDir).mode & 0o777).toBe(0o700);
  });

  it('daily-cap survives a process restart on the same calendar day', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sinkA = openInvocationSink(filePath, { maxBytesPerDay: 200 });
    for (let i = 0; i < 5; i += 1) {
      sinkA.write(makeRow({ ts: `2026-01-01T00:00:0${i}.000Z`, tool: `tool_${i}` }));
    }
    await sinkA.close();
    const sizeAfterA = statSync(filePath).size;
    expect(sizeAfterA).toBeGreaterThan(0);

    // Simulate same-day restart by touching mtime to "now" and re-opening.
    const now = new Date();
    utimesSync(filePath, now, now);

    const sinkB = openInvocationSink(filePath, { maxBytesPerDay: 200 });
    for (let i = 0; i < 50; i += 1) {
      sinkB.write(makeRow({ ts: `2026-01-01T00:00:0${i}.000Z`, tool: `tool_${i}` }));
    }
    await sinkB.close();

    expect(statSync(filePath).size).toBeLessThanOrEqual(200);
  });

  it('write-path day rollover rotates to .jsonl.gz and continues writing to a fresh live file', async () => {
    const filePath = join(dir, 'mcp-invocations.jsonl');
    const RealDate = Date;
    let fakeNow = '2026-01-01T12:00:00.000Z';

    class FakeDate extends RealDate {
      constructor(value?: ConstructorParameters<typeof Date>[0]) {
        if (value === undefined) {
          super(fakeNow);
          return;
        }
        super(value);
      }
      static now(): number {
        return new RealDate(fakeNow).getTime();
      }
    }

    (globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
    const sink = openInvocationSink(filePath);
    try {
      sink.write(makeRow({ ts: '2026-01-01T12:00:00.000Z', tool: 'day1' }));
      await Promise.resolve();
      fakeNow = '2026-01-02T12:00:00.000Z';
      sink.write(makeRow({ ts: '2026-01-02T12:00:00.000Z', tool: 'day2' }));
      await sink.close();
    } finally {
      (globalThis as { Date: DateConstructor }).Date = RealDate;
    }

    const files = readdirSync(dir);
    const rotated = files.find((name) => /^mcp-invocations\.\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(name));
    expect(rotated).toBe('mcp-invocations.2026-01-01.jsonl.gz');
    expect(rotated).toBeDefined();
    expect(files).toContain('mcp-invocations.jsonl');

    const rotatedContent = gunzipSync(readFileSync(join(dir, rotated!))).toString('utf8');
    expect(rotatedContent).toContain('"tool":"day1"');

    const liveContent = readFileSync(filePath, 'utf8');
    expect(liveContent).toContain('"tool":"day2"');
  });

  it('post-close writes do not throw (defensive guard for close+error paths)', async () => {
    const filePath = join(dir, 'inv.jsonl');
    const sink = openInvocationSink(filePath);
    await sink.close();
    expect(() => sink.write(makeRow())).not.toThrow();
  });

  it('restart on a new day rotates immediately based on existing file mtime day', async () => {
    const filePath = join(dir, 'mcp-invocations.jsonl');
    writeFileSync(filePath, `${JSON.stringify(makeRow({ tool: 'day1' }))}\n`);
    const day1 = new Date('2026-01-01T12:00:00.000Z');
    utimesSync(filePath, day1, day1);

    const RealDate = Date;
    const fakeNow = '2026-01-02T12:00:00.000Z';
    class FakeDate extends RealDate {
      constructor(value?: ConstructorParameters<typeof Date>[0]) {
        super(value === undefined ? fakeNow : value);
      }
      static now(): number {
        return new RealDate(fakeNow).getTime();
      }
    }
    (globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;

    const sink = openInvocationSink(filePath);
    try {
      sink.write(makeRow({ ts: '2026-01-02T12:00:00.000Z', tool: 'day2' }));
      await sink.close();
    } finally {
      (globalThis as { Date: DateConstructor }).Date = RealDate;
    }

    const files = readdirSync(dir);
    expect(files).toContain('mcp-invocations.2026-01-01.jsonl.gz');
    const rotatedContent = gunzipSync(
      readFileSync(join(dir, 'mcp-invocations.2026-01-01.jsonl.gz')),
    ).toString('utf8');
    expect(rotatedContent).toContain('"tool":"day1"');
    const liveContent = readFileSync(filePath, 'utf8');
    expect(liveContent).toContain('"tool":"day2"');
  });

  it('closeWriteStream rejects on error instead of hanging forever', async () => {
    class FakeStream extends EventEmitter {
      end(): void {
        this.emit('error', new Error('flush failed'));
      }
    }

    await expect(
      closeWriteStream(new FakeStream() as unknown as { once: (event: string, cb: (...args: unknown[]) => void) => void; end: () => void }),
    ).rejects.toThrow(/flush failed/);
  });

  it('writes continue while background gzip is still running after day rollover', async () => {
    const filePath = join(dir, 'mcp-invocations.jsonl');
    let now = '2026-01-01T12:00:00.000Z';
    let releaseCompression: (() => void) | null = null;
    const compressionGate = new Promise<void>((resolve) => {
      releaseCompression = resolve;
    });
    let releaseReopened: (() => void) | null = null;
    const reopened = new Promise<void>((resolve) => {
      releaseReopened = resolve;
    });
    let releaseRotationIdle: (() => void) | null = null;
    const rotationIdle = new Promise<void>((resolve) => {
      releaseRotationIdle = resolve;
    });
    let syncWrites = 0;

    const sink = openInvocationSink(filePath, {
      testHooks: {
        now: () => new Date(now),
        onSyncWrite: () => {
          syncWrites += 1;
        },
        compressStaged: async (stagedPath: string) => {
          await compressionGate;
          return `${stagedPath}.gz`;
        },
        onRotationReopened: () => {
          releaseReopened?.();
        },
        onRotationIdle: () => {
          releaseRotationIdle?.();
        },
      },
    });

    sink.write(makeRow({ ts: now, tool: 'day1' }));
    now = '2026-01-02T12:00:00.000Z';
    sink.write(makeRow({ ts: now, tool: 'day2-a' }));
    await reopened;
    await rotationIdle;
    sink.write(makeRow({ ts: now, tool: 'day2-b' }));
    expect(syncWrites).toBeGreaterThanOrEqual(2);

    releaseCompression?.();
    await sink.close();
    const liveContent = readFileSync(filePath, 'utf8');
    expect(liveContent).toContain('"tool":"day2-a"');
    expect(liveContent).toContain('"tool":"day2-b"');
  });

  it('same-day writes take a synchronous fast path (counter increments inline)', async () => {
    const filePath = join(dir, 'inv.jsonl');
    let now = '2026-01-01T12:00:00.000Z';
    let syncWrites = 0;
    const sink = openInvocationSink(filePath, {
      testHooks: {
        now: () => new Date(now),
        onSyncWrite: () => {
          syncWrites += 1;
        },
      },
    });

    for (let i = 0; i < 50; i += 1) {
      sink.write(makeRow({ ts: now, tool: `tool_${i}` }));
    }
    expect(syncWrites).toBe(50);
    await sink.close();
  });

  it('pending buffer during rotation drops newest rows at cap with one warning', async () => {
    const filePath = join(dir, 'mcp-invocations.jsonl');
    let now = '2026-01-01T12:00:00.000Z';
    let releasePause: (() => void) | null = null;
    const pause = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const warnSpy = spyOn(console, 'error').mockImplementation(() => {});

    const sink = openInvocationSink(filePath, {
      testHooks: {
        now: () => new Date(now),
        pauseBeforeReopen: async () => {
          await pause;
        },
        maxPendingDuringRotation: 10,
      },
    });

    sink.write(makeRow({ ts: now, tool: 'day1' }));
    now = '2026-01-02T12:00:00.000Z';
    sink.write(makeRow({ ts: now, tool: 'start-rotate' }));
    for (let i = 0; i < 50; i += 1) {
      sink.write(makeRow({ ts: now, tool: `queued_${i}` }));
    }

    releasePause?.();
    await sink.close();

    const warnMessages = warnSpy.mock.calls
      .map((call) => call[0])
      .filter((msg) => String(msg).includes('pending-overflow'));
    expect(warnMessages.length).toBe(1);
    warnSpy.mockRestore();

    const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const toolRows = lines.map((line) => JSON.parse(line).tool as string);
    expect(toolRows).toContain('start-rotate');
    expect(toolRows).toContain('queued_8');
    expect(toolRows).not.toContain('queued_49');
  });
});
