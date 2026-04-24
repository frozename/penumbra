import { expect, test } from 'bun:test';
import { resolveEmbedder } from '../../src/embedder/resolve.js';
import { TestEmbedder } from '../../src/embedder/test-embedder.js';

test('returns sirius when reachable and preferSirius is true', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') return new Response('ok');
      return Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] });
    },
  });

  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    preferSirius: true,
    sirius: { baseUrl: `http://localhost:${server.port}`, token: 't', model: 'm', dim: 4 },
    fallback,
  });
  expect(e.name).toBe('sirius:m');
  server.stop(true);
});

test('returns fallback when sirius is unreachable', async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    preferSirius: true,
    sirius: { baseUrl: 'http://127.0.0.1:1', token: 't', model: 'm', dim: 4 },
    fallback,
  });
  expect(e.name).toBe('test');
});

test('preferSirius=false always returns fallback', async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({ preferSirius: false, fallback });
  expect(e.name).toBe('test');
});
