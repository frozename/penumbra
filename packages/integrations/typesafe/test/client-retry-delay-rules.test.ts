import { expect, test } from "bun:test";

import type { TypesafeFetch } from "../src/client.js";
import type { TypesafeSettings } from "../src/config.js";

import { createTypesafeClient } from "../src/client.js";
import { noul } from "../src/questions.js";

interface HarnessOptions {
  maxRetries?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
}

interface Harness {
  calls: number[];
  sleeps: number[];
  client: ReturnType<typeof createTypesafeClient>;
}

const ENABLED: TypesafeSettings = {
  enabled: true,
  apiKey: "k",
  keySource: "env",
  baseUrl: "https://api.typesafe.ai",
  model: "jev-1.13.0",
  timeoutMs: 10000,
  judgePromotion: "shadow",
};

function harness(responses: Response[], options?: HarnessOptions): Harness {
  const queue = [...responses];
  const calls: number[] = [];
  const sleeps: number[] = [];
  const fetchImpl: TypesafeFetch = (): Promise<Response> => {
    calls.push(calls.length + 1);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("ran out of steps"));
    }
    return Promise.resolve(next);
  };
  const client = createTypesafeClient({
    settings: ENABLED,
    fetch: fetchImpl,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: (): number => 1_000_000,
    random: (): number => 0,
    ...options,
  });
  return { calls, sleeps, client };
}

function errorResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers: headers ?? {} });
}

function okResponse(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200 },
  );
}

const OK_BODY: { q: { type: "noul"; noul: number } } = { q: { type: "noul", noul: 0.5 } };

test("backoffMaxMs caps the exponential backoff delay", async () => {
  const { calls, sleeps, client } = harness(
    [errorResponse(529), errorResponse(529), errorResponse(529), errorResponse(529)],
    { maxRetries: 3, backoffMaxMs: 1500 },
  );
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "server", status: 529, attempts: 4 });
  expect(calls).toHaveLength(4);
  expect(sleeps).toEqual([500, 1000, 1500]);
});

test("jitter scales the backoff delay down by up to a quarter", async () => {
  const { calls, sleeps, client } = harness(
    [errorResponse(529), errorResponse(529), errorResponse(529)],
    { random: (): number => 1 },
  );
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "server", status: 529, attempts: 3 });
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([375, 750]);
});

test("backoffInitialMs option seeds the exponential backoff", async () => {
  const { calls, sleeps, client } = harness(
    [errorResponse(529), errorResponse(529), errorResponse(529)],
    { backoffInitialMs: 100 },
  );
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "server", status: 529, attempts: 3 });
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([100, 200]);
});

test("maxRetries 0 makes a single attempt without sleeping", async () => {
  const { calls, sleeps, client } = harness([errorResponse(529), okResponse(OK_BODY)], {
    maxRetries: 0,
  });
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "server", status: 529, attempts: 1 });
  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
});

test("an HTTP-date Retry-After waits until that instant measured from the injected clock", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "Retry-After": "Thu, 01 Jan 1970 00:16:42 GMT" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
});

test("an HTTP-date Retry-After in the past clamps to a zero wait", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([0]);
});

test("a negative Retry-After seconds value clamps to a zero wait", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "Retry-After": "-3" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([0]);
});

test("a negative retry-after-ms is ignored in favour of Retry-After", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "retry-after-ms": "-5", "Retry-After": "2" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
});

test("a non-finite retry-after-ms is ignored in favour of Retry-After", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "retry-after-ms": "Infinity", "Retry-After": "2" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
});

test("an unparseable Retry-After falls back to exponential backoff", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "Retry-After": "soon" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([500]);
});

test("a retry delay exactly equal to the remaining deadline fails without sleeping", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "retry-after-ms": "10000" }),
    okResponse(OK_BODY),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "rate_limited", status: 429, attempts: 1 });
  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
});
