import { expect, test } from "bun:test";

import { resolveEmbedder } from "@src/embedder/resolve.js";
import { TestEmbedder } from "@src/embedder/test-embedder.js";

const originalFetch = globalThis.fetch;

function mockFetch(fn: typeof fetch): () => void {
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const catchRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
};

test("auto + live embeddings round-trip chooses remote embedder", async () => {
  const restoreFetch = mockFetch(async (url, init) => {
    const req = new Request(url, init);
    expect(new URL(req.url).pathname).toBe("/v1/embeddings");
    const body = (await req.json()) as { input: string[]; model: string };
    expect(body.input).toEqual(["penumbra embedder liveness probe"]);
    expect(body.model).toBe("m");
    return Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] });
  });

  try {
    const fallback = new TestEmbedder({ dim: 4 });
    const e = await resolveEmbedder({
      mode: "auto",
      remote: { baseUrl: "http://embedder.test", model: "m", dim: 4 },
      fallback,
    });
    expect(e.name).toBe("openai:m");
  } finally {
    restoreFetch();
  }
});

test("auto + unreachable embeddings endpoint chooses bundled fallback", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    mode: "auto",
    remote: { baseUrl: "http://127.0.0.1:1", model: "m", dim: 4 },
    fallback,
  });
  expect(e.name).toBe("test");
});

test("auto + wrong-dimension liveness embedding chooses bundled fallback", async () => {
  const restoreFetch = mockFetch(() =>
    Promise.resolve(Response.json({ data: [{ embedding: [0, 0, 0], index: 0 }] })),
  );

  try {
    const fallback = new TestEmbedder({ dim: 4 });
    const e = await resolveEmbedder({
      mode: "auto",
      remote: { baseUrl: "http://embedder.test", model: "m", dim: 4 },
      fallback,
    });
    expect(e.name).toBe("test");
  } finally {
    restoreFetch();
  }
});

test("auto + no baseUrl chooses bundled fallback", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({ mode: "auto", fallback });
  expect(e.name).toBe("test");
});

test("remote mode throws when embeddings endpoint is unreachable", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const err = await catchRejection(
    resolveEmbedder({
      mode: "remote",
      remote: { baseUrl: "http://127.0.0.1:1", model: "m", dim: 4 },
      fallback,
    }),
  );
  expect((err as Error).message).toMatch(/unreachable/i);
});

test("remote mode throws when baseUrl is missing", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const err = await catchRejection(resolveEmbedder({ mode: "remote", fallback }));
  expect((err as Error).message).toMatch(/BASE_URL/);
});

test("bundled mode always chooses fallback", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    mode: "bundled",
    remote: { baseUrl: "http://127.0.0.1:1", model: "m", dim: 4 },
    fallback,
  });
  expect(e.name).toBe("test");
});

test("auto mode skips liveness probe when healthPath is empty", async () => {
  let calledProbe = false;
  const restoreFetch = mockFetch((url) => {
    const req = new Request(url);
    const path = new URL(req.url).pathname;
    if (path === "/v1/embeddings" || path === "/healthz") {
      calledProbe = true;
    }
    return Promise.resolve(Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] }));
  });

  try {
    const fallback = new TestEmbedder({ dim: 4 });
    const e = await resolveEmbedder({
      mode: "auto",
      remote: { baseUrl: "http://embedder.test", model: "m", dim: 4, healthPath: "" },
      fallback,
    });
    expect(e.name).toBe("openai:m");
    expect(calledProbe).toBe(false);
  } finally {
    restoreFetch();
  }
});
