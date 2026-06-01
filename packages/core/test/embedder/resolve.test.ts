import { expect, test } from "bun:test";
import { resolveEmbedder } from "../../src/embedder/resolve.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";

test("auto + reachable health chooses remote embedder", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return new Response("ok", { status: 200 });
      return Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] });
    },
  });

  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    mode: "auto",
    remote: { baseUrl: `http://localhost:${server.port}`, model: "m", dim: 4 },
    fallback,
  });
  expect(e.name).toBe("openai:m");
  server.stop(true);
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
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") {
        calledHealth = true;
        return new Response("no", { status: 500 });
      }
      return Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] });
    },
  });

  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    mode: "auto",
    remote: { baseUrl: `http://localhost:${server.port}`, model: "m", dim: 4, healthPath: "" },
    fallback,
  });
  expect(e.name).toBe("openai:m");
  expect(calledHealth).toBe(false);
  server.stop(true);
});
