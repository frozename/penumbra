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

test("auto + reachable health chooses remote embedder", async () => {
  const restoreFetch = mockFetch(async (url) => {
    expect(new URL(String(url)).pathname).toBe("/healthz");
    return new Response("ok", { status: 200 });
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
  await expect(
    resolveEmbedder({
      mode: "remote",
      remote: { baseUrl: "http://127.0.0.1:1", model: "m", dim: 4 },
      fallback,
    }),
  ).rejects.toThrow(/unreachable/i);
});

test("remote mode throws when baseUrl is missing", async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  await expect(resolveEmbedder({ mode: "remote", fallback })).rejects.toThrow(/BASE_URL/);
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
  const restoreFetch = mockFetch(async (url) => {
    const req = new Request(url);
    const path = new URL(req.url).pathname;
    if (path === "/healthz") {
      calledHealth = true;
      return new Response("no", { status: 500 });
    }
    return Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] });
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
