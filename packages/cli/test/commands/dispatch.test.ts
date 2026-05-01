import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDispatchTimeline } from '../../src/commands/dispatch.js';

let storageRoot = '';

describe('runDispatchTimeline', () => {
  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-dispatch-timeline-'));
    writeFileSync(join(storageRoot, 'port'), '4242\n');
    writeFileSync(join(storageRoot, 'token'), 'tok\n');
  });

  afterEach(() => {
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  test('fetches dispatch events with bearer auth and prints a readable timeline', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const printed: string[] = [];

    await runDispatchTimeline({
      handoffId: 'handoff-1',
      json: false,
      storageRoot,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          events: [
            {
              handoff_id: 'handoff-1',
              worker_id: 'worker-a',
              source: 'worker',
              kind: 'dispatch.start',
              ts: '2026-05-01T12:00:00.000Z',
              meta: { agent: 'codex', hop: 1 },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      print: (line) => { printed.push(line); },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4242/dispatch/events?handoff_id=handoff-1');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok');
    expect(printed.join('\n')).toContain('2026-05-01T12:00:00.000Z');
    expect(printed.join('\n')).toContain('worker');
    expect(printed.join('\n')).toContain('dispatch.start');
    expect(printed.join('\n')).toContain('"agent":"codex"');
  });

  test('--json prints the raw response pretty-printed', async () => {
    let printed = '';

    await runDispatchTimeline({
      handoffId: 'handoff-2',
      json: true,
      storageRoot,
      fetch: async () => new Response(JSON.stringify({
        events: [
          {
            handoff_id: 'handoff-2',
            worker_id: null,
            source: 'daemon',
            kind: 'watchdog.tick',
            ts: '2026-05-01T12:00:01.000Z',
            meta: null,
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      print: (line) => { printed = line; },
    });

    expect(printed).toBe(JSON.stringify({
      events: [
        {
          handoff_id: 'handoff-2',
          worker_id: null,
          source: 'daemon',
          kind: 'watchdog.tick',
          ts: '2026-05-01T12:00:01.000Z',
          meta: null,
        },
      ],
    }, null, 2));
  });

  test('prints no events marker for empty timelines', async () => {
    const printed: string[] = [];

    await runDispatchTimeline({
      handoffId: 'handoff-empty',
      json: false,
      storageRoot,
      fetch: async () => new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      print: (line) => { printed.push(line); },
    });

    expect(printed).toEqual(['(no events)']);
  });
});
