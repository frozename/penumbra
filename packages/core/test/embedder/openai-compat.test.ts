import { expect, test } from "bun:test";
import { OpenAICompatEmbedder } from "../../src/embedder/openai-compat.js";

const originalFetch = globalThis.fetch;

function mockFetch(fn: typeof fetch): () => void {
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("POSTs to /v1/embeddings and parses the OpenAI-compat response", async () => {
  const restoreFetch = mockFetch(async (url, init) => {
    const req = new Request(url, init);
    expect(new URL(req.url).pathname).toBe("/v1/embeddings");
    expect(req.headers.get("authorization")).toBe("Bearer test-token");
    const body = (await req.json()) as { input: string[] };
    const vectors = body.input.map((_, i) => Array.from({ length: 4 }, (_, j) => i + j));
    return Response.json({
      data: vectors.map((v, i) => ({ embedding: v, index: i, object: "embedding" })),
    });
  });

  try {
    const e = new OpenAICompatEmbedder({
      baseUrl: "http://embedder.test",
      token: "test-token",
      model: "bge-small",
      dim: 4,
    });
    expect(e.name).toBe("openai:bge-small");
    const out = await e.embed(["a", "b"]);
    expect(out.length).toBe(2);
    expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
    expect(Array.from(out[1]!)).toEqual([1, 2, 3, 4]);
  } finally {
    restoreFetch();
  }
});

test("omits Authorization header when token is not configured", async () => {
  const restoreFetch = mockFetch(async (url, init) => {
    const req = new Request(url, init);
    expect(req.headers.has("authorization")).toBe(false);
    return Response.json({ data: [{ embedding: [0, 1, 2, 3], index: 0, object: "embedding" }] });
  });

  try {
    const e = new OpenAICompatEmbedder({
      baseUrl: "http://embedder.test",
      model: "m",
      dim: 4,
    });
    const out = await e.embed(["x"]);
    expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
  } finally {
    restoreFetch();
  }
});

test("honors custom authHeader/authScheme", async () => {
  const restoreFetch = mockFetch(async (url, init) => {
    const req = new Request(url, init);
    expect(req.headers.get("x-api-key")).toBe("ApiKey test-token");
    expect(req.headers.has("authorization")).toBe(false);
    return Response.json({ data: [{ embedding: [1, 1, 1, 1], index: 0, object: "embedding" }] });
  });

  try {
    const e = new OpenAICompatEmbedder({
      baseUrl: "http://embedder.test",
      token: "test-token",
      model: "m",
      dim: 4,
      authHeader: "x-api-key",
      authScheme: "ApiKey",
    });
    const out = await e.embed(["x"]);
    expect(Array.from(out[0]!)).toEqual([1, 1, 1, 1]);
  } finally {
    restoreFetch();
  }
});

test("throws on non-2xx", async () => {
  const restoreFetch = mockFetch(async () => new Response("boom", { status: 500 }));
  try {
    const e = new OpenAICompatEmbedder({
      baseUrl: "http://embedder.test",
      token: "t",
      model: "m",
      dim: 4,
    });
    await expect(e.embed(["x"])).rejects.toThrow(/embeddings/);
  } finally {
    restoreFetch();
  }
});
