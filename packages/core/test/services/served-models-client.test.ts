import { describe, expect, test } from "bun:test";

import { fetchServedModelEntries, fetchServedModels, servedModelsUrl } from "../../src/index.js";

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

  test("throws when the inventory endpoint is unavailable", () => {
    expect(
      fetchServedModels("http://127.0.0.1:7944", {
        fetch: () => new Response("bad", { status: 502 }),
      }),
    ).rejects.toThrow("served models probe failed");
  });
});
