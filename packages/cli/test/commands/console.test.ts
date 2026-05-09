import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConsoleServer, runConsole } from '../../src/commands/console.js';

let storageRoot = '';
let distRoot = '';
let mockDaemon: ReturnType<typeof Bun.serve> | null = null;
let mockDaemonRequests: Array<{ method: string; path: string; authorization: string | null; cookie: string | null }> = [];

const TOKEN = 'test-token-xyz';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self';">
    <title>console</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

function startMockDaemon(): number {
  mockDaemonRequests = [];
  mockDaemon = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      mockDaemonRequests.push({
        method: req.method,
        path: url.pathname + url.search,
        authorization: req.headers.get('authorization'),
        cookie: req.headers.get('cookie'),
      });
      if (url.pathname === '/handoffs' && url.searchParams.get('status') === 'pending') {
        return new Response(JSON.stringify({ handoffs: [{ id: 'h1' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/echo') {
        return new Response('ok', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return mockDaemon.port!;
}

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-console-cli-store-'));
  distRoot = mkdtempSync(join(tmpdir(), 'penumbra-console-cli-dist-'));
  const daemonPort = startMockDaemon();
  writeFileSync(join(storageRoot, 'port'), `${daemonPort}\n`);
  writeFileSync(join(storageRoot, 'token'), `${TOKEN}\n`);
  writeFileSync(join(distRoot, 'index.html'), FIXTURE_HTML);
  writeFileSync(join(distRoot, 'app.js'), '// hello world');
});

afterEach(() => {
  if (mockDaemon) {
    mockDaemon.stop(true);
    mockDaemon = null;
  }
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  if (distRoot) rmSync(distRoot, { recursive: true, force: true });
});

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(/penumbra_session=([^;]+)/);
  return m ? m[1]! : null;
}

test('prepareConsoleServer: index.html sets HttpOnly session cookie + security headers + no-store', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain('penumbra_session=');
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).toContain('SameSite=Strict');
    expect(setCookie!).toContain('Path=/');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<title>console</title>');
    // Bearer token must NOT appear in served HTML
    expect(html).not.toContain(TOKEN);
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: served index.html contains no token string anywhere', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/`);
    const html = await res.text();
    expect(html.indexOf(TOKEN)).toBe(-1);
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: /api request without cookie is rejected with 401', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/api/handoffs?status=pending`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_session');
    // Mock daemon must not have seen the request
    expect(mockDaemonRequests.length).toBe(0);
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: /api with valid cookie is proxied to daemon with bearer token', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get('set-cookie'));
    expect(cookieValue).not.toBeNull();
    expect(cookieValue).toBe(prepared.sessionNonce);

    const apiRes = await fetch(`${prepared.url}/api/handoffs?status=pending`, {
      headers: { Cookie: `penumbra_session=${cookieValue}` },
    });
    expect(apiRes.status).toBe(200);
    const payload = (await apiRes.json()) as { handoffs: Array<{ id: string }> };
    expect(payload.handoffs[0]!.id).toBe('h1');

    expect(mockDaemonRequests.length).toBe(1);
    const recorded = mockDaemonRequests[0]!;
    expect(recorded.method).toBe('GET');
    expect(recorded.path).toBe('/handoffs?status=pending');
    expect(recorded.authorization).toBe(`Bearer ${TOKEN}`);
    // Cookie should NOT have been forwarded to the daemon
    expect(recorded.cookie).toBeNull();
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: /api response strips upstream Set-Cookie + Authorization, keeps security headers', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get('set-cookie'));
    const apiRes = await fetch(`${prepared.url}/api/handoffs?status=pending`, {
      headers: { Cookie: `penumbra_session=${cookieValue}` },
    });
    expect(apiRes.headers.get('x-frame-options')).toBe('DENY');
    expect(apiRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(apiRes.headers.get('set-cookie')).toBeNull();
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: serves static assets and 404 for unknown', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const ok = await fetch(`${prepared.url}/app.js`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('// hello world');
    expect(ok.headers.get('x-frame-options')).toBe('DENY');

    const missing = await fetch(`${prepared.url}/does-not-exist.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-frame-options')).toBe('DENY');
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: rejects path traversal with 403 or 404', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/../../../etc/passwd`);
    expect([403, 404]).toContain(res.status);
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: binds 127.0.0.1 only', async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    expect(prepared.url.startsWith('http://127.0.0.1:')).toBe(true);
  } finally {
    await prepared.stop();
  }
});

test('prepareConsoleServer: each launch generates a fresh session nonce', async () => {
  const a = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  const b = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    expect(a.sessionNonce).not.toBe(b.sessionNonce);
    expect(a.sessionNonce.length).toBe(64);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('prepareConsoleServer: cookie from one launch is rejected by another launch', async () => {
  const a = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  const b = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${b.url}/api/handoffs?status=pending`, {
      headers: { Cookie: `penumbra_session=${a.sessionNonce}` },
    });
    expect(res.status).toBe(401);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('runConsole: missing dist directory → exitCode 1 with build hint', async () => {
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: '/nonexistent-penumbra-dist-xyz',
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  const errOut = stderr.join('\n');
  expect(errOut).toMatch(/Console assets not found/);
  expect(errOut).toMatch(/bun .* packages\/console run build/);
});

test('runConsole: missing index.html in dist dir → exitCode 1', async () => {
  rmSync(join(distRoot, 'index.html'));
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  expect(stderr.join('\n')).toMatch(/Console assets not found/);
});

test('runConsole: missing token file → exitCode 1', async () => {
  rmSync(join(storageRoot, 'token'));
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  expect(stderr.join('\n')).toMatch(/no token found/);
});

test('runConsole: missing port file → exitCode 1', async () => {
  rmSync(join(storageRoot, 'port'));
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  expect(stderr.join('\n')).toMatch(/no daemon port/);
});

test('runConsole: returns immediately with exitCode 0 in test mode', async () => {
  const stdout: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stdout: (s) => stdout.push(s),
  });
  expect(result.exitCode).toBe(0);
  expect(stdout.join('\n')).toMatch(/Operator console: http:\/\/127\.0\.0\.1:\d+/);
});
