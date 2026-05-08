import { expect, test } from 'bun:test';
import { createOriginHostGuard } from '../src/origin-host.js';

const guard = createOriginHostGuard({ allowRemote: false });

function req(opts: { url?: string; origin?: string | null; host?: string | null } = {}): Request {
  const headers = new Headers();
  if (opts.origin !== undefined && opts.origin !== null) headers.set('origin', opts.origin);
  // Bun's Request constructor doesn't auto-populate Host (the HTTP transport
  // does in real flows). Default to a loopback Host so the test models
  // a normal browser/CLI request unless the case overrides it.
  const url = opts.url ?? 'http://127.0.0.1:51257/x';
  if (opts.host !== undefined) {
    if (opts.host !== null) headers.set('host', opts.host);
  } else {
    headers.set('host', new URL(url).host);
  }
  return new Request(url, { headers });
}

test('null when Origin missing and Host=127.0.0.1', () => {
  expect(guard(req({ url: 'http://127.0.0.1:51257/x' }))).toBeNull();
});

test('null when Origin is the literal "null" string', () => {
  expect(guard(req({ origin: 'null' }))).toBeNull();
});

test('null when Origin is loopback http', () => {
  expect(guard(req({ origin: 'http://127.0.0.1:51257' }))).toBeNull();
  expect(guard(req({ origin: 'http://localhost:51257' }))).toBeNull();
  expect(guard(req({ origin: 'https://localhost' }))).toBeNull();
});

test('403 forbidden_origin when Origin is foreign', async () => {
  const denied = guard(req({ origin: 'https://evil.example.com' }));
  expect(denied?.status).toBe(403);
  const body = await denied!.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('forbidden_origin');
  expect(body.error.message).toContain('evil.example.com');
});

test('403 when Host is non-loopback (DNS rebinding defense)', async () => {
  const denied = guard(req({ host: 'evil.example.com' }));
  expect(denied?.status).toBe(403);
  const body = await denied!.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('forbidden_origin');
  expect(body.error.message).toContain('evil.example.com');
});

test('null when Host=localhost and Origin missing', () => {
  expect(guard(req({ url: 'http://localhost/x' }))).toBeNull();
  expect(guard(req({ url: 'http://localhost:51257/x' }))).toBeNull();
});

test('allowRemote bypass — non-loopback Origin and Host both pass', () => {
  const remote = createOriginHostGuard({ allowRemote: true });
  expect(remote(req({ origin: 'https://evil.example.com', host: 'evil.example.com' }))).toBeNull();
});

test('default opts (no allowRemote) is fail-closed', async () => {
  const def = createOriginHostGuard();
  const denied = def(req({ origin: 'https://evil.example.com' }));
  expect(denied?.status).toBe(403);
});

test('403 when Host header is missing entirely', async () => {
  const denied = guard(req({ host: null }));
  expect(denied?.status).toBe(403);
  const body = await denied!.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('forbidden_origin');
});
