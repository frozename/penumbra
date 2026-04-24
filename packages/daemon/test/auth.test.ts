import { expect, test } from 'bun:test';
import { createBearerAuth } from '../src/auth.js';

test('returns 401 when no Authorization header', async () => {
  const auth = createBearerAuth({ token: 'secret' });
  const req = new Request('http://x/test');
  const denied = auth(req);
  expect(denied?.status).toBe(401);
});

test('returns 401 when token mismatches', async () => {
  const auth = createBearerAuth({ token: 'secret' });
  const req = new Request('http://x/test', {
    headers: { authorization: 'Bearer wrong' },
  });
  const denied = auth(req);
  expect(denied?.status).toBe(401);
});

test('returns null when token matches', async () => {
  const auth = createBearerAuth({ token: 'secret' });
  const req = new Request('http://x/test', {
    headers: { authorization: 'Bearer secret' },
  });
  expect(auth(req)).toBeNull();
});
