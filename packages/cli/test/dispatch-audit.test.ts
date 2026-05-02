import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDispatchAudit, runDispatchAudit } from '../src/commands/dispatch-audit.js';

const report = {
  handoff_id: 'h-1',
  status: 'watchdog_only',
  terminal: true,
  trustworthy: false,
  summary: 'watchdog failed the handoff without dispatch.end',
  missing_events: ['dispatch.end'],
  evidence: {
    handoff_status: 'failed',
    event_count: 3,
    response_count: 0,
    worktree_changed: null,
    reconciled: null,
    watchdog_failed: true,
    cancel_requested: false,
    adapter_streaming: null,
  },
  recommended_action: 'retry',
} as const;

let storageRoot = '';

describe('formatDispatchAudit', () => {
  test('formats a readable multi-line summary', () => {
    expect(formatDispatchAudit(report)).toBe([
      'handoff: h-1',
      'status: watchdog_only',
      'trustworthy: no',
      'summary: watchdog failed the handoff without dispatch.end',
      'recommended_action: retry',
      'missing_events: dispatch.end',
    ].join('\n'));
  });

  test('formats empty missing events as none', () => {
    expect(formatDispatchAudit({ ...report, missing_events: [] })).toContain('missing_events: none');
  });
});

describe('runDispatchAudit', () => {
  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-dispatch-audit-'));
    writeFileSync(join(storageRoot, 'port'), '4242\n');
    writeFileSync(join(storageRoot, 'token'), 'tok\n');
  });

  afterEach(() => {
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  test('fetches the dispatch audit and prints the formatted report', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const printed: string[] = [];
    const fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ report }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await runDispatchAudit({
      handoffId: 'handoff-1',
      json: false,
      storageRoot,
      fetch,
      print: (line) => { printed.push(line); },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4242/dispatch/audit?handoff_id=handoff-1');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok');
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('handoff: h-1');
    expect(printed[0]).toContain('status: watchdog_only');
    expect(printed[0]).toContain('trustworthy: no');
    expect(printed[0]).toContain('recommended_action: retry');
  });

  test('--json prints the raw report JSON instead of the formatted summary', async () => {
    let printed = '';

    await runDispatchAudit({
      handoffId: 'handoff-2',
      json: true,
      storageRoot,
      fetch: async () => new Response(JSON.stringify({ report }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      print: (line) => { printed = line; },
    });

    expect(JSON.parse(printed)).toEqual(report);
    expect(printed).toContain('\n  "handoff_id": "h-1"');
  });

  test('throws on a 404 response without printing a report', async () => {
    const printed: string[] = [];

    await expect(runDispatchAudit({
      handoffId: 'missing-handoff',
      json: false,
      storageRoot,
      fetch: async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
      print: (line) => { printed.push(line); },
    })).rejects.toThrow('penumbra dispatch audit: daemon /dispatch/audit returned HTTP 404');

    expect(printed).toHaveLength(0);
  });
});
