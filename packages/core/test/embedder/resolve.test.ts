import { expect, test } from "bun:test";

import { resolveEmbedder } from "../../src/embedder/resolve.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";

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

test("auto + reachable health chooses remote embedder", async () => {
  const restoreFetch = mockFetch((url) => {
    const req = new Request(url);
    expect(new URL(req.url).pathname).toBe("/healthz");
    return Promise.resolve(new Response("ok", { status: 200 }));
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

test("auto + unreachable health chooses bundled fallback", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    mode: "auto",
    remote: { baseUrl: "http://127.0.0.1:1", model: "m", dim: 4 },
    fallback,
  });
  expect(e.name).toBe("test");
});

test("auto + no baseUrl chooses bundled fallback", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({ mode: "auto", fallback });
  expect(e.name).toBe("test");
});

test("remote mode throws when endpoint is unreachable", async () => {
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

test("auto mode skips health probe when healthPath is empty", async () => {
  let calledHealth = false;
  const restoreFetch = mockFetch((url) => {
    const req = new Request(url);
    const path = new URL(req.url).pathname;
    if (path === "/healthz") {
      calledHealth = true;
      return Promise.resolve(new Response("no", { status: 500 }));
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
    expect(calledHealth).toBe(false);
  } finally {
    restoreFetch();
  }
});
