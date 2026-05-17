import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { createJudgePool, type JudgeEntry } from '../src/workers/t2-judge-pool.js';

function makeJudge(name: string, baseUrl: string, model = 'judge-model'): JudgeEntry {
  return { name, baseUrl, apiKey: '', model };
}

test('round-robin distributes calls across two healthy judges', async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge('a', 'http://a'), makeJudge('b', 'http://b')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any, init: any) => {
      const body = JSON.parse(init?.body as string);
      seen.push(String(url).includes('http://a') ? "a" : "b");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), { status: 200 });
    },
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke('first');
  await pool.invoke('second');
  await pool.invoke('third');

  expect(seen).toEqual(['a', 'b', 'a']);
});

test('judge that fails twice in a tick is skipped for the rest of that tick', async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge('a', 'http://a'), makeJudge('b', 'http://b')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any) => {
      const which = String(url).includes('http://a') ? 'a' : 'b';
      seen.push(which);
      if (which === 'a') throw new Error('a-fail');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), { status: 200 });
    },
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  // Invoke 1: round-robin starts at A → fails → falls to B → success.   seen += ['a','b']
  // Invoke 2: nextIndex still 0 (set on B's success); A fails (2nd time → unhealthy), B succeeds. seen += ['a','b']
  // Invoke 3: A unhealthy → skipped → B succeeds.                          seen += ['b']
  // Invoke 4: same.                                                        seen += ['b']
  await pool.invoke('1');
  await pool.invoke('2');
  await pool.invoke('3');
  await pool.invoke('4');

  expect(seen).toEqual(['a', 'b', 'a', 'b', 'b', 'b']);
});

test('resetTickHealth re-enables a previously unhealthy judge', async () => {
  const seen: string[] = [];
  let aShouldFail = true;
  const pool = createJudgePool({
    judges: [makeJudge('a', 'http://a'), makeJudge('b', 'http://b')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any) => {
      const which = String(url).includes('http://a') ? 'a' : 'b';
      seen.push(which);
      if (which === 'a' && aShouldFail) throw new Error('a-fail');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), { status: 200 });
    },
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  // Two invokes drive A to unhealthy (2 fails), each falling back to B.
  await pool.invoke('1');
  await pool.invoke('2');
  // A should now be skipped.
  seen.length = 0;
  await pool.invoke('3');
  expect(seen).toEqual(['b']);

  // Reset health + stop A failing — next invoke should hit A again.
  pool.resetTickHealth();
  aShouldFail = false;
  seen.length = 0;
  await pool.invoke('4');
  expect(seen[0]).toBe('a');
});

test('all judges unhealthy this tick throws', async () => {
  const pool = createJudgePool({
    judges: [makeJudge('a', 'http://a'), makeJudge('b', 'http://b')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async () => { throw new Error('fetch failed'); },
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  // Invoke 1: A fails (1), B fails (1) → throws lastError 'fetch failed'.
  await expect(pool.invoke('1')).rejects.toThrow('fetch failed');
  // Invoke 2: A fails (now 2 → unhealthy), B fails (now 2 → unhealthy) → throws "all judges unhealthy".
  await expect(pool.invoke('2')).rejects.toThrow('all judges unhealthy this tick');
  // Subsequent invokes also short-circuit.
  await expect(pool.invoke('3')).rejects.toThrow('all judges unhealthy this tick');
});

test('single-judge pool degenerates to that one judge', async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge('a', 'http://a')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any, init: any) => {
      const body = JSON.parse(init?.body as string);
      seen.push(body.messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), { status: 200 });
    },
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke('1');
  await pool.invoke('2');
  await pool.invoke('3');

  expect(seen).toEqual(['1', '2', '3']);
});

test('parseResponse error counts as judge failure', async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge('a', 'http://a'), makeJudge('b', 'http://b')],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any) => {
      const which = String(url).includes('http://a') ? 'a' : 'b';
      seen.push(which);
      // A returns malformed content, B returns valid JSON.
      const content = which === 'a' ? 'not-json' : '{"memories":[]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    },
    unhealthyAfter: 1,
    promptBuilder: (transcript) => transcript,
    parseResponse: (rawContent) => {
      if (rawContent === 'not-json') throw new Error('bad parse');
      return [];
    },
  });

  // Invoke 1: A's parseResponse throws → A unhealthy after 1 fail. Fall to B → succeeds.
  await expect(pool.invoke('x')).resolves.toEqual([]);
  // Invoke 2: A is unhealthy → skipped. B succeeds.
  await expect(pool.invoke('y')).resolves.toEqual([]);

  expect(seen).toEqual(['a', 'b', 'b']);
});

test('judge caPath is plumbed into fetch tls.ca', async () => {
  const pemText = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n';
  const dir = mkdtempSync(join(tmpdir(), 't2-judge-pool-'));
  const caPath = join(dir, 'judge-ca.pem');
  writeFileSync(caPath, pemText, 'utf8');

  const seen: any[] = [];
  const pool = createJudgePool({
    judges: [
      { name: 'with-ca', baseUrl: 'http://a', apiKey: '', model: 'judge-model', caPath },
      { name: 'without-ca', baseUrl: 'http://b', apiKey: '', model: 'judge-model' },
    ],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (_url: any, init: any) => {
      seen.push(init);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), { status: 200 });
    },
    unhealthyAfter: 1,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke('first');
  await pool.invoke('second');

  expect(seen[0]?.tls?.ca).toBe(pemText);
  expect(seen[1]?.tls).toBeUndefined();

  rmSync(dir, { recursive: true, force: true });
});
