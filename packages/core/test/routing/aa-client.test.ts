import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AaTransport, fetchAaModels, readAaApiKey } from "@src/routing/aa-client.js";

function aaModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aa:model:1",
    name: "Model 1",
    slug: "model-1",
    model_creator: {
      id: "creator:1",
      name: "Creator",
      slug: "creator",
    },
    evaluations: {
      artificial_analysis_intelligence_index: 74.2,
      artificial_analysis_coding_index: 61.5,
      livecodebench: 55.1,
    },
    pricing: {
      price_1m_blended_3_to_1: 3.25,
      price_1m_input_tokens: 1.2,
      price_1m_output_tokens: 7.9,
    },
    median_output_tokens_per_second: 88.4,
    median_time_to_first_token_seconds: 0.74,
    median_time_to_first_answer_token: 1.1,
    ...overrides,
  };
}

function aaResponse(data: Record<string, unknown>[] = [aaModel()]): Record<string, unknown> {
  return {
    status: "success",
    prompt_options: {
      data_version: "2026-08-24",
      benchmark_version: "bench-2026-08",
    },
    data,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe("Artificial Analysis API client", () => {
  test("returns state:'unconfigured' when the key file is absent - never throws, never fabricates a default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-key-"));
    try {
      const result = await readAaApiKey(join(dir, "missing.key"));

      expect(result).toEqual({ state: "unconfigured" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sends a raw x-api-key header, not Authorization: Bearer", async () => {
    const seenHeaders: Headers[] = [];
    const transport: AaTransport = {
      fetch(_input, init) {
        seenHeaders.push(new Headers(init?.headers));
        return jsonResponse(aaResponse());
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.get("x-api-key")).toBe("secret-key");
    expect(seenHeaders[0]?.has("authorization")).toBe(false);
  });

  test("aborts via AbortSignal.timeout rather than hanging", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const controller = new AbortController();
    let timeoutMs: number | null = null;
    AbortSignal.timeout = (ms: number): AbortSignal => {
      timeoutMs = ms;
      return controller.signal;
    };
    try {
      const transport: AaTransport = {
        fetch(_input, init) {
          expect(init?.signal).toBe(controller.signal);
          return jsonResponse(aaResponse());
        },
      };

      const result = await fetchAaModels({ apiKey: "secret-key", transport, timeoutMs: 1234 });

      expect(result.ok).toBe(true);
      expect(timeoutMs).toBe(1234);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  test("retries on 429 honoring Retry-After and on 5xx, gives up after the configured cap with a typed failure", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const transport: AaTransport = {
      fetch() {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": "2" } },
          );
        }
        return jsonResponse({ error: "unavailable" }, { status: 503 });
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxAttempts: 3,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http");
      expect(result.error.status).toBe(503);
      expect(result.error.attempts).toBe(3);
      expect(result.error.message).not.toContain("secret-key");
    }
    expect(attempts).toBeLessThanOrEqual(3);
    expect(delays).toContain(2000);
  });

  test("caps Retry-After sleeps at maxRetryDelayMs", async () => {
    const delays: number[] = [];
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(
          { error: "rate limited" },
          { status: 429, headers: { "retry-after": "120" } },
        );
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxAttempts: 2,
      maxRetryDelayMs: 1000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(result.ok).toBe(false);
    expect(delays).toEqual([1000]);
  });

  test("non-finite maxAttempts falls back to the default attempt count", async () => {
    let attempts = 0;
    const transport: AaTransport = {
      fetch() {
        attempts += 1;
        if (attempts <= 3) {
          return jsonResponse({ error: "unavailable" }, { status: 503 });
        }
        return jsonResponse(aaResponse());
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxAttempts: Infinity,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.attempts).toBe(3);
    }
    expect(attempts).toBe(3);
  });

  test("the key never appears in a thrown error's message or the typed failure", async () => {
    const key = "super-secret-aa-key";
    const transport: AaTransport = {
      fetch() {
        throw new Error(`network failure for ${key}`);
      },
    };

    const result = await fetchAaModels({ apiKey: key, transport, maxAttempts: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(key);
      expect(JSON.stringify(result.error)).not.toContain(key);
    }
  });

  test("a response missing tier-gated fields validates with those fields absent, not zero-filled", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(
          aaResponse([
            aaModel({
              evaluations: {
                artificial_analysis_intelligence_index: 80.4,
              },
              pricing: {},
              median_output_tokens_per_second: undefined,
              median_time_to_first_token_seconds: undefined,
              median_time_to_first_answer_token: undefined,
            }),
          ]),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const model = result.snapshot.models[0];
      expect(model?.evaluations.artificial_analysis_coding_index).toBeUndefined();
      expect(Object.hasOwn(model?.evaluations ?? {}, "artificial_analysis_coding_index")).toBe(
        false,
      );
      expect(model?.pricing.price_1m_input_tokens).toBeUndefined();
      expect(Object.hasOwn(model?.pricing ?? {}, "price_1m_input_tokens")).toBe(false);
      expect(model?.median_output_tokens_per_second).toBeUndefined();
    }
  });

  test("one invalid model row is skipped while valid rows are kept and skip provenance is recorded", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(
          aaResponse([
            aaModel({ slug: "kept-model" }),
            aaModel({ id: 42, slug: "bad-id-model" }),
            aaModel({ id: 43, slug: undefined }),
            aaModel({ slug: "also-kept" }),
          ]),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.models.map((model) => model.slug)).toEqual([
        "kept-model",
        "also-kept",
      ]);
      expect(result.snapshot.skippedModelCount).toBe(2);
      expect(result.snapshot.skippedModelSamples).toEqual(["bad-id-model", "index:2"]);
    }
  });

  test("oversized responses fail before JSON parsing", async () => {
    const transport: AaTransport = {
      fetch() {
        return new Response(JSON.stringify(aaResponse([aaModel({ name: "x".repeat(200) })])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxResponseBytes: 64,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("oversized_response");
    }
  });

  test("invalid response failures report the real attempt number", async () => {
    let attempts = 0;
    const transport: AaTransport = {
      fetch() {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse({ error: "unavailable" }, { status: 503 });
        }
        return new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxAttempts: 2,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.attempts).toBe(2);
    }
  });

  test('a 401 with body {"error":"API key is required"} maps to a typed auth failure, not a retry', async () => {
    let attempts = 0;
    const transport: AaTransport = {
      fetch() {
        attempts += 1;
        return jsonResponse({ error: "API key is required" }, { status: 401 });
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport, maxAttempts: 3 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("auth");
      expect(result.error.status).toBe(401);
      expect(result.error.attempts).toBe(1);
    }
    expect(attempts).toBe(1);
  });

  test("readAaApiKey trims a configured key and treats blank files as unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-key-"));
    try {
      const configured = join(dir, "configured.key");
      const blank = join(dir, "blank.key");
      writeFileSync(configured, "  real-key\n");
      writeFileSync(blank, "   \n\t");

      expect(await readAaApiKey(configured)).toEqual({ state: "configured", apiKey: "real-key" });
      expect(await readAaApiKey(blank)).toEqual({ state: "unconfigured" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
