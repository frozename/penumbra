import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConsoleServer, runConsole } from '../../src/commands/console.js';

let storageRoot = '';
let distRoot = '';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';">
    <meta name="penumbra-config" content="">
    <title>console</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-console-cli-store-'));
  distRoot = mkdtempSync(join(tmpdir(), 'penumbra-console-cli-dist-'));
  writeFileSync(join(storageRoot, 'port'), '4242\n');
  writeFileSync(join(storageRoot, 'token'), 'test-token-xyz\n');
  writeFileSync(join(distRoot, 'index.html'), FIXTURE_HTML);
  writeFileSync(join(distRoot, 'app.js'), '// hello world');
});

afterEach(() => {
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  if (distRoot) rmSync(distRoot, { recursive: true, force: true });
});

test('prepareConsoleServer: serves index.html with injected meta tag (token + url)', async () => {
  const prepared = prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Meta tag injected with single-quote-delimited content
    const match = html.match(/<meta name="penumbra-config" content='([^']+)'>/);
    expect(match).not.toBeNull();
    const decoded = match![1]!
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const config = JSON.parse(decoded) as { baseUrl: string; token: string };
    expect(config.token).toBe('test-token-xyz');
    expect(config.baseUrl).toBe('http://127.0.0.1:4242');
    // CSP passthrough
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy"`);
  } finally {
    prepared.stop();
  }
});

test('prepareConsoleServer: serves static assets and 404 for unknown', async () => {
  const prepared = prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const ok = await fetch(`${prepared.url}/app.js`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('// hello world');

    const missing = await fetch(`${prepared.url}/does-not-exist.js`);
    expect(missing.status).toBe(404);
  } finally {
    prepared.stop();
  }
});

test('prepareConsoleServer: rejects path traversal with 403', async () => {
  const prepared = prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/../../../etc/passwd`);
    // Either normalized away (404) or refused (403); never 200.
    expect([403, 404]).toContain(res.status);
  } finally {
    prepared.stop();
  }
});

test('prepareConsoleServer: binds 127.0.0.1 only', () => {
  const prepared = prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    expect(prepared.url.startsWith('http://127.0.0.1:')).toBe(true);
  } finally {
    prepared.stop();
  }
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

test('prepareConsoleServer: HTML escapes special chars in token', async () => {
  // Token containing characters that require HTML-escaping inside an attribute
  writeFileSync(join(storageRoot, 'token'), `foo&bar<'\"`);
  const prepared = prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/`);
    const html = await res.text();
    const match = html.match(/<meta name="penumbra-config" content='([^']+)'>/);
    expect(match).not.toBeNull();
    // Raw single-quote / ampersand / angle brackets must be escaped inside the attribute
    const raw = match![1]!;
    expect(raw).not.toContain("'");
    // Decode and confirm the original token round-trips
    const decoded = raw
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const config = JSON.parse(decoded) as { token: string };
    expect(config.token).toBe(`foo&bar<'\"`);
  } finally {
    prepared.stop();
  }
});
