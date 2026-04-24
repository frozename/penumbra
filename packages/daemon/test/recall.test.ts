import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('POST /recall returns empty array when DB is empty', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x', project_id: null }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  } finally { d.stop(); }
});

test('POST /recall with invalid input returns 400', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  } finally { d.stop(); }
});
