import { expect, test } from "bun:test";

import type { BenchResult } from "./bench.js";

import { runBench } from "./bench.js";

interface OpenAiRequestBody {
  model: string;
  temperature: number;
  max_tokens: number;
  google?: { thinking_config?: { thinking_budget?: number } };
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchImpl = (input: FetchInput, init?: FetchInit) => Promise<Response>;

// Bun's `typeof fetch` includes a `preconnect` method that test mocks have no
// reason to stub. This single typed factory bridges that SDK gap so each test
// can declare a lightweight call signature without per-mock casting.
function makeFetchMock(impl: FetchImpl): typeof fetch {
  return impl as unknown as typeof fetch;
}

test("runBench: returns one result per task in BENCH_TASKS, all stub-served", async () => {
  let calls = 0;
  const fetchImpl = makeFetchMock(() => {
    calls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "STUB_REPLY" } }],
          model: "stub-model",
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  });

  const url = `http://stub/v1`;
  const results: BenchResult[] = await runBench({
    label: "stub-test",
    url,
    model: "stub",
    fetch: fetchImpl,
  });
  expect(results.length).toBe(9);
  for (const r of results) {
    expect(r.label).toBe("stub-test");
    expect(r.task).toMatch(/^T(?:[4-9]|1[0-2])$/);
    expect(r.model).toBe("stub");
    expect(r.answer).toBe("STUB_REPLY");
    expect(typeof r.latencyMs).toBe("number");
    expect(r.error).toBeUndefined();
  }
  expect(calls).toBe(9);
});

test("runBench: missing fixture file is captured per-task without aborting the run", async () => {
  const fetchImpl = makeFetchMock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    ),
  );

  const url = `http://stub/v1`;
  const results = await runBench({
    label: "fixture-test",
    url,
    model: "stub",
    fixtureOverrides: { T4: "/tmp/this-file-definitely-does-not-exist-zzz.md" },
    fetch: fetchImpl,
  });
  expect(results.length).toBe(9);
  const t4 = results.find((r) => r.task === "T4")!;
  expect(t4.error).toMatch(/fixture/i);
  expect(t4.answer).toBeUndefined();
  expect(results.filter((r) => !r.error).length).toBe(8);
});

test("runBench: stub returning empty body is captured as an error, not a crash", async () => {
  const fetchImpl = makeFetchMock(() =>
    Promise.resolve(new Response("", { headers: { "content-type": "application/json" } })),
  );

  const url = `http://stub/v1`;
  const results = await runBench({ label: "empty-test", url, model: "stub", fetch: fetchImpl });
  expect(results.length).toBe(9);
  for (const r of results) {
    expect(r.error).toBeDefined();
    expect(r.answer).toBeUndefined();
  }
});

test("runBench: extraBody lands in the POST body", async () => {
  let requestBody: OpenAiRequestBody | undefined;
  const fetchImpl = makeFetchMock(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    requestBody = (await req.json()) as OpenAiRequestBody;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });

  const url = `http://stub/v1`;
  await runBench({
    label: "extra-body-test",
    url,
    model: "stub",
    extraBody: { google: { thinking_config: { thinking_budget: 0 } } },
    fetch: fetchImpl,
  });
  expect(requestBody?.google?.thinking_config?.thinking_budget).toBe(0);
  // Ensure base fields are still there
  expect(requestBody?.model).toBe("stub");
  expect(requestBody?.temperature).toBe(0);
});

test("runBench: maxTokensMultiplier scales max_tokens in the POST body", async () => {
  let requestBody: OpenAiRequestBody | undefined;
  const fetchImpl = makeFetchMock(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    requestBody = (await req.json()) as OpenAiRequestBody;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });

  await runBench({
    label: "multiplier-test",
    url: "http://stub/v1",
    model: "stub",
    maxTokensMultiplier: 2,
    fetch: fetchImpl,
  });
  expect(requestBody?.max_tokens).toBe(800);
});
