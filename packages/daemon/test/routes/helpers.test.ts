import { expect, test } from 'bun:test';
import { bodyJson, json } from '../../src/routes/_helpers.js';

test('json helper returns JSON response with status and content type', async () => {
  const res = json({ ok: true }, 201);
  expect(res.status).toBe(201);
  expect(res.headers.get('content-type')).toBe('application/json');
  await expect(res.json()).resolves.toEqual({ ok: true });
});

test('bodyJson helper returns parsed payload on valid JSON', async () => {
  const req = new Request('http://x/test', {
    method: 'POST',
    body: JSON.stringify({ a: 1 }),
    headers: { 'content-type': 'application/json' },
  });
  await expect(bodyJson(req)).resolves.toEqual({ a: 1 });
});

test('bodyJson helper returns null on invalid JSON', async () => {
  const req = new Request('http://x/test', {
    method: 'POST',
    body: '{not-json',
    headers: { 'content-type': 'application/json' },
  });
  await expect(bodyJson(req)).resolves.toBeNull();
});
