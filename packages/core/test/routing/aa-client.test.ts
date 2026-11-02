import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AaTransport,
  DEFAULT_AA_MODELS_ENDPOINT,
  fetchAaModels,
  readAaApiKey,
} from "@src/routing/aa-client.js";

const aaLanguageFreeSample: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/aa-language-free-sample.json", import.meta.url), "utf8"),
);

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

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    }),
  );
}

function aaFreeModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aa-free:model:1",
    name: "Free Model 1",
    slug: "free-model-1",
    release_date: "2026-07-01",
    model_creator: {
      id: "creator:openai",
      name: "OpenAI",
    },
    evaluations: {
      artificial_analysis_intelligence_index: 60.1,
      artificial_analysis_coding_index: null,
      artificial_analysis_agentic_index: null,
      artificial_analysis_engineering_index: 58.4,
    },
    artificial_analysis_intelligence_index_cost: null,
    pricing: {
      price_1m_input_tokens: 1,
      price_1m_output_tokens: 4,
      price_1m_cache_hit_tokens: null,
      price_1m_cache_write_tokens: null,
    },
    performance: {
      median_output_tokens_per_second: 80,
      median_time_to_first_token_seconds: 0.4,
      median_time_to_first_answer_token_seconds: 0.7,
      median_end_to_end_response_time_seconds: 3.2,
    },
    ...overrides,
  };
}

function aaFreeResponse(
  data: Record<string, unknown>[] = [aaFreeModel()],
  pagination: { page?: number; has_more?: boolean } = {},
): Record<string, unknown> {
  const page = pagination.page ?? 1;
  const hasMore = pagination.has_more ?? false;
  return {
    tier: "free",
    intelligence_index_version: 5,
    pagination: {
      page,
      page_size: 200,
      total_pages: hasMore ? page + 1 : page,
      has_more: hasMore,
    },
    data,
  };
}

function requestedPage(input: string): number {
  return Number(new URL(input).searchParams.get("page") ?? "1");
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
      expect(timeoutMs!).toBe(1234);
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
        return Promise.resolve(
          new Response(JSON.stringify(aaResponse([aaModel({ name: "x".repeat(200) })])), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
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
        return Promise.resolve(
          new Response("{not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
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

describe("Artificial Analysis /language/models/free migration (#369)", () => {
  test("the default endpoint is the free language-models endpoint replacing the retired /data/llms/models API", () => {
    expect(DEFAULT_AA_MODELS_ENDPOINT).toBe(
      "https://artificialanalysis.ai/api/v2/language/models/free",
    );
  });

  test("the free envelope parses into a non-empty snapshot: derived creator slugs, null-creator rows kept, performance and computed blended price mapped", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(aaLanguageFreeSample);
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.models).toHaveLength(3);
      expect(result.snapshot.dataVersion).toBe("5");
      expect(result.snapshot.benchmarkVersion).toBe("5");

      const [openaiModel, metaModel, unknownCreatorModel] = result.snapshot.models;
      expect(openaiModel?.model_creator).toEqual({
        id: "e67e56e3-15cd-43db-b679-da4660a69f41",
        name: "OpenAI",
        slug: "openai",
      });
      expect(metaModel?.model_creator).toEqual({
        id: "2b8f9d41-3c7e-4f1a-9b2d-5e6a7c8d9e0f",
        name: "Meta AI",
        slug: "meta-ai",
      });
      expect(unknownCreatorModel?.model_creator).toEqual({
        id: "unknown",
        name: "unknown",
        slug: "unknown",
      });

      expect(openaiModel?.median_output_tokens_per_second).toBe(62.221);
      expect(openaiModel?.median_time_to_first_token_seconds).toBe(0.585);
      expect(openaiModel?.median_time_to_first_answer_token).toBe(0.9);
      expect(metaModel?.median_output_tokens_per_second).toBeNull();
      expect(metaModel?.median_time_to_first_token_seconds).toBeNull();
      expect(metaModel?.median_time_to_first_answer_token).toBeNull();
      expect(unknownCreatorModel?.median_output_tokens_per_second).toBe(120);

      expect(openaiModel?.pricing.price_1m_blended_3_to_1).toBe(8);
      expect(openaiModel?.pricing.price_1m_input_tokens).toBe(4);
      expect(openaiModel?.pricing.price_1m_output_tokens).toBe(20);
      expect(metaModel?.pricing.price_1m_blended_3_to_1).toBeNull();
      expect(unknownCreatorModel?.pricing.price_1m_blended_3_to_1).toBe(0.5);
    }
  });

  test("a missing creator slug is derived from model_creator.name: lowercased, non-alphanumeric runs collapsed to '-', trimmed", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(
          aaFreeResponse([
            aaFreeModel({
              slug: "slug-a",
              model_creator: { id: "creator:acme", name: "ACME Research, Inc." },
            }),
            aaFreeModel({
              slug: "slug-b",
              model_creator: { id: "creator:zai", name: "  Z AI  " },
            }),
          ]),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.models[0]?.model_creator.slug).toBe("acme-research-inc");
      expect(result.snapshot.models[1]?.model_creator.slug).toBe("z-ai");
    }
  });

  test("a null model_creator keeps the row with an 'unknown' creator triple, never drops the model", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(
          aaFreeResponse([aaFreeModel({ slug: "uncreatored", model_creator: null })]),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.models).toHaveLength(1);
      expect(result.snapshot.models[0]?.model_creator).toEqual({
        id: "unknown",
        name: "unknown",
        slug: "unknown",
      });
    }
  });

  test("price_1m_blended_3_to_1 is computed as (3*input + output)/4 when both are present, else null", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(
          aaFreeResponse([
            aaFreeModel({
              slug: "both-prices",
              pricing: {
                price_1m_input_tokens: 1.5,
                price_1m_output_tokens: 6,
                price_1m_cache_hit_tokens: null,
                price_1m_cache_write_tokens: null,
              },
            }),
            aaFreeModel({
              slug: "output-only",
              pricing: {
                price_1m_input_tokens: null,
                price_1m_output_tokens: 0.9,
                price_1m_cache_hit_tokens: null,
                price_1m_cache_write_tokens: null,
              },
            }),
            aaFreeModel({
              slug: "input-only",
              pricing: {
                price_1m_input_tokens: 0.4,
                price_1m_output_tokens: null,
                price_1m_cache_hit_tokens: null,
                price_1m_cache_write_tokens: null,
              },
            }),
          ]),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.models[0]?.pricing.price_1m_blended_3_to_1).toBeCloseTo(2.625);
      expect(result.snapshot.models[1]?.pricing.price_1m_blended_3_to_1).toBeNull();
      expect(result.snapshot.models[2]?.pricing.price_1m_blended_3_to_1).toBeNull();
    }
  });

  test("while pagination.has_more is true the client requests the next page via the page query param and concatenates the pages", async () => {
    const requestUrls: string[] = [];
    const transport: AaTransport = {
      fetch(input) {
        requestUrls.push(input);
        const page = requestedPage(input);
        if (page <= 1) {
          return jsonResponse(
            aaFreeResponse([aaFreeModel({ slug: "page-one-model" })], {
              page: 1,
              has_more: true,
            }),
          );
        }
        return jsonResponse(
          aaFreeResponse([aaFreeModel({ slug: `page-${String(page)}-model` })], {
            page,
            has_more: false,
          }),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(true);
    expect(requestUrls).toHaveLength(2);
    expect(new URL(requestUrls[1]!).searchParams.get("page")).toBe("2");
    if (result.ok) {
      expect(result.snapshot.models.map((model) => model.slug)).toEqual([
        "page-one-model",
        "page-2-model",
      ]);
    }
  });

  test("a hard 10-page cap ends an unbounded has_more loop with a failure, never loops forever", async () => {
    let calls = 0;
    const transport: AaTransport = {
      fetch(input) {
        calls += 1;
        const page = requestedPage(input);
        return jsonResponse(
          aaFreeResponse([aaFreeModel({ slug: `page-${String(page)}-model` })], {
            page,
            has_more: true,
          }),
        );
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(false);
    expect(calls).toBe(10);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
    }
  });

  test("a response whose every data row fails validation is an invalid_response failure, never a successful empty snapshot", async () => {
    const transport: AaTransport = {
      fetch() {
        return jsonResponse(aaFreeResponse([{ not_a_model: true }, { also_not_a_model: 42 }]));
      },
    };

    const result = await fetchAaModels({ apiKey: "secret-key", transport });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
    }
  });

  test("HTTP 410 maps to a 'gone' failure kind and is not retried", async () => {
    let attempts = 0;
    const transport: AaTransport = {
      fetch() {
        attempts += 1;
        return jsonResponse({ error: "endpoint retired" }, { status: 410 });
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("gone");
      expect(result.error.status).toBe(410);
      expect(result.error.attempts).toBe(1);
    }
    expect(attempts).toBe(1);
  });

  test("HTTP 403 maps to a 'forbidden' failure kind and is not retried", async () => {
    let attempts = 0;
    const transport: AaTransport = {
      fetch() {
        attempts += 1;
        return jsonResponse({ error: "API key tier lacks access" }, { status: 403 });
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      transport,
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("forbidden");
      expect(result.error.status).toBe(403);
      expect(result.error.attempts).toBe(1);
    }
    expect(attempts).toBe(1);
  });

  test("the legacy {status, prompt_options, data} envelope still parses for a custom endpoint override", async () => {
    let calls = 0;
    const transport: AaTransport = {
      fetch() {
        calls += 1;
        return jsonResponse(aaResponse());
      },
    };

    const result = await fetchAaModels({
      apiKey: "secret-key",
      endpoint: "https://aa-mirror.internal/api/v2/data/llms/models",
      transport,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    if (result.ok) {
      expect(result.snapshot.models[0]?.slug).toBe("model-1");
      expect(result.snapshot.dataVersion).toBe("2026-08-24");
      expect(result.snapshot.benchmarkVersion).toBe("bench-2026-08");
    }
  });
});
