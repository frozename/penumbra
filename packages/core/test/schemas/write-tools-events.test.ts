import { describe, expect, it, test } from 'bun:test';
import {
  FsWriteAppliedPayload,
  FsEditAppliedPayload,
  TerminalSpawnedPayload,
  TerminalExitedPayload,
  TerminalKilledPayload,
} from '../../src/schemas/write-tools-events.js';

describe('FsWriteAppliedPayload', () => {
  const valid = {
    path: '/tmp/test.txt',
    bytes: 42,
    sha256: 'a'.repeat(64),
    prev_sha256: 'b'.repeat(64),
    handoff_id: 'h-1',
  };

  test('parses valid payload', () => {
    const p = FsWriteAppliedPayload.parse(valid);
    expect(p.path).toBe('/tmp/test.txt');
    expect(p.bytes).toBe(42);
    expect(p.prev_sha256).toBe('b'.repeat(64));
  });

  test('accepts null prev_sha256', () => {
    const p = FsWriteAppliedPayload.parse({ ...valid, prev_sha256: null });
    expect(p.prev_sha256).toBeNull();
  });

  test('rejects bad sha256 length', () => {
    expect(() =>
      FsWriteAppliedPayload.parse({ ...valid, sha256: 'short' }),
    ).toThrow();
  });

  test('rejects negative bytes', () => {
    expect(() =>
      FsWriteAppliedPayload.parse({ ...valid, bytes: -1 }),
    ).toThrow();
  });
});

describe('FsEditAppliedPayload', () => {
  const valid = {
    path: '/tmp/test.txt',
    bytes_added: 10,
    bytes_removed: 5,
    sha256: 'a'.repeat(64),
    prev_sha256: 'b'.repeat(64),
    handoff_id: 'h-1',
  };

  test('parses valid payload', () => {
    const p = FsEditAppliedPayload.parse(valid);
    expect(p.bytes_added).toBe(10);
    expect(p.bytes_removed).toBe(5);
  });

  test('rejects bad sha256 length', () => {
    expect(() =>
      FsEditAppliedPayload.parse({ ...valid, sha256: 'deadbeef' }),
    ).toThrow();
  });
});

describe('TerminalSpawnedPayload', () => {
  const valid = {
    terminal_id: 't-1',
    argv: ['bash', '-c', 'echo hi'],
    cwd: '/tmp',
    env_keys: ['PATH', 'HOME'],
    handoff_id: 'h-1',
  };

  test('parses valid payload', () => {
    const p = TerminalSpawnedPayload.parse(valid);
    expect(p.terminal_id).toBe('t-1');
    expect(p.argv).toEqual(['bash', '-c', 'echo hi']);
  });
});

describe('TerminalExitedPayload', () => {
  const valid = {
    terminal_id: 't-1',
    exit_code: 0,
    signal: null,
    output_bytes: 1024,
    output_truncated: false,
    duration_ms: 1500,
    handoff_id: 'h-1',
  };

  test('parses valid payload', () => {
    const p = TerminalExitedPayload.parse(valid);
    expect(p.exit_code).toBe(0);
    expect(p.output_truncated).toBe(false);
  });

  test('accepts string signal', () => {
    const p = TerminalExitedPayload.parse({ ...valid, signal: 'SIGTERM' });
    expect(p.signal).toBe('SIGTERM');
  });

  test('rejects negative duration_ms', () => {
    expect(() =>
      TerminalExitedPayload.parse({ ...valid, duration_ms: -1 }),
    ).toThrow();
  });
});

describe('TerminalKilledPayload', () => {
  const valid = {
    terminal_id: 't-1',
    reason: 'timeout' as const,
    handoff_id: 'h-1',
  };

  test('parses valid payload', () => {
    const p = TerminalKilledPayload.parse(valid);
    expect(p.reason).toBe('timeout');
  });

  test('rejects invalid reason enum', () => {
    expect(() =>
      TerminalKilledPayload.parse({ ...valid, reason: 'unknown_reason' }),
    ).toThrow();
  });

  test('accepts all defined reasons', () => {
    const reasons = ['timeout', 'output_overflow', 'dispatch_end', 'idle_ttl', 'max_lifetime', 'operator', 'cancelled'] as const;
    for (const reason of reasons) {
      expect(() => TerminalKilledPayload.parse({ ...valid, reason })).not.toThrow();
    }
  });
});
