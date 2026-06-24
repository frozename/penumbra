import { describe, expect, test } from "bun:test";

import { fetchLlamactlServedModels, llamactlModelsUrl } from "../../src/index.js";

describe("llamactl client", () => {
  test("builds the /v1/models URL from base URLs with or without /v1", () => {
    expect(llamactlModelsUrl("http://127.0.0.1:7944")).toBe("http://127.0.0.1:7944/v1/models");
    expect(llamactlModelsUrl("http://127.0.0.1:7944/v1")).toBe("http://127.0.0.1:7944/v1/models");
    expect(llamactlModelsUrl("http://127.0.0.1:7944/v1/")).toBe("http://127.0.0.1:7944/v1/models");
  });

  test("returns a deduped served model id set from /v1/models", async () => {
    const requestedUrls: string[] = [];
    const models = await fetchLlamactlServedModels("http://127.0.0.1:7944", {
      timeoutMs: 25,
      fetch: async (url, init) => {
        requestedUrls.push(String(url));
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

  test("throws when the inventory endpoint is unavailable", async () => {
    await expect(
      fetchLlamactlServedModels("http://127.0.0.1:7944", {
        fetch: async () => new Response("bad", { status: 502 }),
      }),
    ).rejects.toThrow("llamactl models probe failed");
  });
});
