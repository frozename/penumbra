import { describe, expect, test } from "bun:test";

import {
  fetchServedModelEntries,
  fetchServedModels,
  ServedModelsProbeError,
  servedModelsUrl,
} from "@src/index.js";

describe("served models client", () => {
  test("builds the /v1/models URL from base URLs with or without /v1", () => {
    expect(servedModelsUrl("http://127.0.0.1:7944")).toBe("http://127.0.0.1:7944/v1/models");
    expect(servedModelsUrl("http://127.0.0.1:7944/v1")).toBe("http://127.0.0.1:7944/v1/models");
    expect(servedModelsUrl("http://127.0.0.1:7944/v1/")).toBe("http://127.0.0.1:7944/v1/models");
  });

  test("returns deduped served model ids from /v1/models", async () => {
    const requestedUrls: string[] = [];
    const models = await fetchServedModels("http://127.0.0.1:7944", {
      timeoutMs: 25,
      fetch: (url, init) => {
        requestedUrls.push(url);
        expect(init?.signal).toBeDefined();
        return new Response(
          JSON.stringify({
            data: [
              { id: "bge-m3-GGUF/bge-m3-FP16.gguf" },
              { id: "bge-m3" },
              { id: "bge-m3" },
              { id: 42 },
            ],
          }),
        );
      },
    });

    expect(requestedUrls).toEqual(["http://127.0.0.1:7944/v1/models"]);
    expect([...models].sort()).toEqual(["bge-m3", "bge-m3-GGUF/bge-m3-FP16.gguf"]);
  });

  test("returns metadata entries for inventory callers", async () => {
    const entries = await fetchServedModelEntries("http://127.0.0.1:7944", {
      fetch: () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "repo/model.gguf", owned_by: "mac-mini", created: 42 },
              { id: "model", owned_by: "mac-mini", created: 42 },
              { id: "", owned_by: "ignored", created: 1 },
            ],
          }),
        ),
    });

    expect(entries).toEqual([
      { id: "repo/model.gguf", owned_by: "mac-mini", created: 42 },
      { id: "model", owned_by: "mac-mini", created: 42 },
    ]);
  });

  test("throws when the inventory endpoint is unavailable", async () => {
    let caught: unknown;
    try {
      await fetchServedModels("http://127.0.0.1:7944", {
        fetch: () => new Response("bad", { status: 502 }),
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) throw new Error("expected fetchServedModels to reject");
    expect(caught.message).toContain("served models probe failed");
  });

  test("a non-2xx response rejects with ServedModelsProbeError carrying the status", async () => {
    let caught: unknown;
    try {
      await fetchServedModels("http://127.0.0.1:7944", {
        fetch: () => Promise.resolve(new Response("down", { status: 503 })),
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof ServedModelsProbeError)) {
      throw new Error("expected a ServedModelsProbeError");
    }
    expect(caught.status).toBe(503);
    expect(caught.message).toBe("served models probe failed: 503");
    expect(caught.name).toBe("ServedModelsProbeError");
    expect(caught instanceof Error).toBe(true);
  });

  test("sends bearer authorization and custom CA when provided", async () => {
    let seenInit: { headers?: Record<string, string>; tls?: { ca: string } } | undefined;
    await fetchServedModels("https://gw.example.invalid:7843/v1", {
      bearerToken: "tok",
      caPem: "PEM",
      fetch: (_url, init) => {
        seenInit = init;
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
      },
    });

    expect(seenInit?.headers?.authorization).toBe("Bearer tok");
    expect(seenInit?.tls?.ca).toBe("PEM");
  });

  test("omits headers and tls entirely when no bearer token or CA is provided", async () => {
    let seenKeys: string[] = [];
    await fetchServedModels("http://127.0.0.1:7944", {
      fetch: (_url, init) => {
        seenKeys = Object.keys(init ?? {});
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "bge-m3" }] })));
      },
    });

    expect(seenKeys).toEqual(["signal"]);
  });
});
