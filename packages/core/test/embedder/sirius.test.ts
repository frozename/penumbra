import { expect, test } from 'bun:test';
import { SiriusEmbedder } from '../../src/embedder/sirius.js';

test('POSTs to /v1/embeddings and parses the OpenAI-compat response', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      expect(new URL(req.url).pathname).toBe('/v1/embeddings');
      expect(req.headers.get('authorization')).toBe('Bearer test-token');
      const body = (await req.json()) as { input: string[] };
      const vectors = body.input.map((_, i) => Array.from({ length: 4 }, (_, j) => i + j));
      return Response.json({
        data: vectors.map((v, i) => ({ embedding: v, index: i, object: 'embedding' })),
      });
    },
  });

  const e = new SiriusEmbedder({
    baseUrl: `http://localhost:${server.port}`,
    token: 'test-token',
    model: 'bge-small',
    dim: 4,
  });
  const out = await e.embed(['a', 'b']);
  expect(out.length).toBe(2);
  expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
  expect(Array.from(out[1]!)).toEqual([1, 2, 3, 4]);
  server.stop(true);
});

test('throws on non-2xx', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
  const e = new SiriusEmbedder({
    baseUrl: `http://localhost:${server.port}`,
    token: 't', model: 'm', dim: 4,
  });
  await expect(e.embed(['x'])).rejects.toThrow(/sirius embeddings/);
  server.stop(true);
});
