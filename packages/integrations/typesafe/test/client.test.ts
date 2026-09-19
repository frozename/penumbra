import { afterEach, expect, spyOn, test } from "bun:test";

import type { TypesafeClientOptions, TypesafeFetch } from "../src/client.js";
import type { TypesafeSettings } from "../src/config.js";
import type { TypesafeQuestion, TypesafeResult } from "../src/types.js";

import { createTypesafeClient } from "../src/client.js";
import { choice, noul, score } from "../src/questions.js";

type FetchStep = Response | Error | "throw" | "hang";

interface RecordedInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

interface RecordedCall {
  url: string;
  init: RecordedInit;
}

function scriptedFetch(steps: FetchStep[]): {
  calls: RecordedCall[];
  fetchImpl: TypesafeFetch;
} {
  const calls: RecordedCall[] = [];
  const queue = [...steps];
  const fetchImpl: TypesafeFetch = (url, init): Promise<Response> => {
    calls.push({ url, init });
    const step = queue.shift();
    if (step instanceof Response) {
      return Promise.resolve(step);
    }
    if (step instanceof Error) {
      return Promise.reject(step);
    }
    if (step === "throw") {
      throw new Error("synchronous fetch failure");
    }
    if (step === "hang") {
      return new Promise<Response>((_resolve, reject): void => {
        const onAbort = (): void => {
          reject(new Error("aborted"));
        };
        if (init.signal.aborted) {
          onAbort();
          return;
        }
        init.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    return Promise.reject(new Error("scriptedFetch ran out of steps"));
  };
  return { calls, fetchImpl };
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

interface Harness {
  calls: RecordedCall[];
  sleeps: number[];
  client: ReturnType<typeof createTypesafeClient>;
}

function harness(steps: FetchStep[], options?: Partial<TypesafeClientOptions>): Harness {
  const { calls, fetchImpl } = scriptedFetch(steps);
  const sleeps: number[] = [];
  const client = createTypesafeClient({
    settings: ENABLED,
    fetch: fetchImpl,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 1_000_000,
    random: () => 0,
    ...options,
  });
  return { calls, sleeps, client };
}

function okResponse(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 312, output_tokens: 48 },
    }),
    { status: 200 },
  );
}

function errorResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers: headers ?? {} });
}

const restored: { mockRestore: () => void }[] = [];

afterEach((): void => {
  for (const spy of restored.splice(0)) {
    spy.mockRestore();
  }
});

test("disabled settings short-circuit before any fetch", async () => {
  const settings: TypesafeSettings = {
    enabled: false,
    reason: "no_key",
    judgePromotion: "shadow",
  };
  const { calls, client } = harness([okResponse({})], { settings });
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "disabled", status: null, attempts: 0 });
  expect(calls).toHaveLength(0);
});

test("posts the contract wire shape to the systemone endpoint", async () => {
  const { calls, client } = harness([okResponse({ durable: { type: "noul", noul: 0.5 } })]);
  const state = { ticket: "t-1" };
  const questions = { durable: noul("Is it durable?") };
  await client.evaluate({ state, questions });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(call.init.method).toBe("POST");
  expect(call.init.headers).toEqual({
    Authorization: "Bearer k",
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  expect(JSON.parse(call.init.body) as unknown).toEqual({
    state,
    model: "jev-1.13.0",
    questions: { durable: { type: "noul", instructions: "Is it durable?" } },
  });
});

test("success maps model, typed answers and usage", async () => {
  const { client } = harness([
    okResponse({
      durable: { type: "noul", noul: 0.83 },
      team: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.7, technical: 0.3 },
        confidence: 0.7,
      },
      risk: {
        type: "score",
        score: 1,
        legend: { "0": "low", "1": "high" },
        probabilities: { "0": 0.2, "1": 0.8 },
        confidence: 0.8,
      },
    }),
  ]);
  const result = await client.evaluate({
    state: "s",
    questions: {
      durable: noul("Is it durable?"),
      team: choice("Which team?", { billing: "Payments", technical: null }),
      risk: score("How risky?", ["low", "high"]),
    },
  });
  expect(result).toEqual({
    ok: true,
    model: "jev-1.13.0",
    answers: {
      durable: { type: "noul", noul: 0.83 },
      team: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.7, technical: 0.3 },
        confidence: 0.7,
      },
      risk: {
        type: "score",
        score: 1,
        legend: { "0": "low", "1": "high" },
        probabilities: { "0": 0.2, "1": 0.8 },
        confidence: 0.8,
      },
    },
    usage: { inputTokens: 312, outputTokens: 48 },
    attempts: 1,
  });
});

test("trailing slashes in the base url collapse to a single slash before v1", async () => {
  const settings: TypesafeSettings = { ...ENABLED, baseUrl: "https://api.typesafe.ai/" };
  const { calls, client } = harness([okResponse({ q: { type: "noul", noul: 0.1 } })], {
    settings,
  });
  await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
});

test("401 maps to auth without retrying", async () => {
  const { calls, client } = harness([errorResponse(401)]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "auth", status: 401, attempts: 1 });
  expect(calls).toHaveLength(1);
});

test("403 maps to auth without retrying", async () => {
  const { calls, client } = harness([errorResponse(403)]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "auth", status: 403, attempts: 1 });
  expect(calls).toHaveLength(1);
});

test("422 maps to invalid_request without retrying", async () => {
  const { calls, client } = harness([errorResponse(422)]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "invalid_request", status: 422, attempts: 1 });
  expect(calls).toHaveLength(1);
});

test("429 honoring retry-after-ms then succeeds", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "retry-after-ms": "250" }),
    okResponse({ q: { type: "noul", noul: 0.5 } }),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([250]);
});

test("429 honoring Retry-After seconds then succeeds", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(429, { "Retry-After": "2" }),
    okResponse({ q: { type: "noul", noul: 0.5 } }),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
});

test("529 exhausting retries maps to server", async () => {
  const { calls, sleeps, client } = harness([
    errorResponse(529),
    errorResponse(529),
    errorResponse(529),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "server", status: 529, attempts: 3 });
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("408 exhausting retries maps to timeout", async () => {
  const { calls, client } = harness([errorResponse(408), errorResponse(408), errorResponse(408)]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "timeout", status: 408, attempts: 3 });
  expect(calls).toHaveLength(3);
});

test("a Retry-After beyond the remaining deadline fails instead of sleeping", async () => {
  const { calls, sleeps, client } = harness([errorResponse(429, { "Retry-After": "30" })]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "rate_limited", status: 429, attempts: 1 });
  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
});

test("the deadline aborts an in-flight attempt", async () => {
  const settings: TypesafeSettings = { ...ENABLED, timeoutMs: 50 };
  const { calls, client } = harness(["hang"], { settings });
  const started = Date.now();
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  const elapsed = Date.now() - started;
  expect(result).toEqual({ ok: false, kind: "timeout", status: null, attempts: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.init.signal.aborted).toBe(true);
  expect(elapsed).toBeLessThan(2000);
});

test("a pre-aborted caller signal returns timeout without fetching", async () => {
  const { calls, client } = harness([okResponse({})]);
  const controller = new AbortController();
  controller.abort();
  const result = await client.evaluate({
    state: "s",
    questions: { q: noul("i") },
    signal: controller.signal,
  });
  expect(result).toEqual({ ok: false, kind: "timeout", status: null, attempts: 0 });
  expect(calls).toHaveLength(0);
});

test("a caller abort mid-attempt returns timeout", async () => {
  const { calls, client } = harness(["hang"]);
  const controller = new AbortController();
  const pending = client.evaluate({
    state: "s",
    questions: { q: noul("i") },
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  expect(result).toEqual({ ok: false, kind: "timeout", status: null, attempts: 1 });
  expect(calls).toHaveLength(1);
});

test("transport rejections retry then succeed", async () => {
  const { calls, client } = harness([
    new TypeError("socket reset"),
    new TypeError("socket reset"),
    okResponse({ q: { type: "noul", noul: 0.4 } }),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toMatchObject({ ok: true, attempts: 3 });
  expect(calls).toHaveLength(3);
});

test("transport rejections exhausted map to transport", async () => {
  const { calls, client } = harness([
    new TypeError("down"),
    new TypeError("down"),
    new TypeError("down"),
  ]);
  const result = await client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(result).toEqual({ ok: false, kind: "transport", status: null, attempts: 3 });
  expect(calls).toHaveLength(3);
});

test("a synchronous fetch throw resolves to transport instead of rejecting", async () => {
  const { client } = harness(["throw"]);
  const pending = client.evaluate({ state: "s", questions: { q: noul("i") } });
  expect(await pending).toEqual({
    ok: false,
    kind: "transport",
    status: null,
    attempts: 3,
  });
});

const INVALID_RESPONSE_CASES: {
  name: string;
  questions: Record<string, TypesafeQuestion>;
  body: string;
}[] = [
  {
    name: "a non-JSON body",
    questions: { q: noul("i") },
    body: "this is not json",
  },
  {
    name: "usage missing",
    questions: { q: noul("i") },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: { q: { type: "noul", noul: 0.5 } },
    }),
  },
  {
    name: "a requested id missing",
    questions: { q: noul("i") },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "an unrequested id present",
    questions: { q: noul("i") },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: { type: "noul", noul: 0.5 },
        extra: { type: "noul", noul: 0.1 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "a noul question answered with a choice answer",
    questions: { q: noul("i") },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 0.9 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "noul out of range",
    questions: { q: noul("i") },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: { q: { type: "noul", noul: 1.3 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "choice not among the criteria options",
    questions: { q: choice("Which team?", { billing: "Payments", technical: null }) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "choice",
          choice: "other",
          probabilities: { billing: 0.5, other: 0.5 },
          confidence: 0.5,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "choice probabilities with an extra key beyond the criteria",
    questions: { q: choice("Which team?", { billing: "Payments", technical: null }) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.5, technical: 0.4, other: 0.1 },
          confidence: 0.5,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "choice probabilities missing a criteria key",
    questions: { q: choice("Which team?", { billing: "Payments", technical: null }) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 1 },
          confidence: 0.5,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "score probabilities with a level above the rubric",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "score",
          score: 1,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "0": 0.2, "1": 0.3, "2": 0.4, "3": 0.1 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "score probabilities with a negative level",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "score",
          score: 1,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "-1": 0.1, "0": 0.3, "1": 0.3, "2": 0.3 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "score probabilities missing a rubric level",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "score",
          score: 1,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "0": 0.5, "2": 0.5 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "score legend with a key outside the rubric",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "score",
          score: 1,
          legend: { "0": "low", "1": "medium", "2": "high", "9": "absurd" },
          probabilities: { "0": 0.3, "1": 0.4, "2": 0.3 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "score above the rubric range",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "score",
          score: 3,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "score below the rubric range",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        q: {
          type: "score",
          score: -1,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: "a non-finite score",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: '{"model":"jev-1.13.0","answers":{"q":{"type":"score","score":1e999,"legend":{"0":"low","1":"medium","2":"high"},"probabilities":{"0":0.2,"1":0.3,"2":0.5},"confidence":0.8}},"usage":{"input_tokens":1,"output_tokens":1}}',
  },
  {
    name: "a score question answered with a noul answer",
    questions: { q: score("How risky?", ["low", "medium", "high"]) },
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
];

test.each(INVALID_RESPONSE_CASES)("200 with $name -> invalid_response", async (c) => {
  const { calls, client } = harness([new Response(c.body, { status: 200 })]);
  const result = await client.evaluate({ state: "s", questions: c.questions });
  expect(result).toEqual({ ok: false, kind: "invalid_response", status: 200, attempts: 1 });
  expect(calls).toHaveLength(1);
});

test("well-formed answers at the boundaries of each shape still pass", async () => {
  const { client } = harness([
    okResponse({
      durable: { type: "noul", noul: 0 },
      team: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 1, technical: 0 },
        confidence: 1,
      },
      risk: {
        type: "score",
        score: 2,
        legend: { "0": "low", "1": "medium", "2": "high" },
        probabilities: { "0": 0, "1": 0, "2": 1 },
        confidence: 0.9,
      },
    }),
  ]);
  const result = await client.evaluate({
    state: "s",
    questions: {
      durable: noul("Is it durable?"),
      team: choice("Which team?", { billing: "Payments", technical: null }),
      risk: score("How risky?", ["low", "medium", "high"]),
    },
  });
  expect(result).toMatchObject({ ok: true, attempts: 1 });
});

const INVALID_REQUEST_CASES: {
  name: string;
  questions: Record<string, TypesafeQuestion>;
}[] = [
  { name: "an empty questions map", questions: {} },
  {
    name: "a score question with a single level",
    questions: { q: { type: "score", instructions: "r?", criteria: ["only"] } },
  },
];

test.each(INVALID_REQUEST_CASES)("$name -> invalid_request without fetching", async (c) => {
  const { calls, client } = harness([okResponse({})]);
  const result = await client.evaluate({ state: "s", questions: c.questions });
  expect(result).toEqual({ ok: false, kind: "invalid_request", status: null, attempts: 0 });
  expect(calls).toHaveLength(0);
});

test("never logs and never echoes response bodies into the result", async () => {
  const spies = [
    spyOn(console, "log").mockImplementation(() => undefined),
    spyOn(console, "info").mockImplementation(() => undefined),
    spyOn(console, "warn").mockImplementation(() => undefined),
    spyOn(console, "error").mockImplementation(() => undefined),
    spyOn(console, "debug").mockImplementation(() => undefined),
  ];
  restored.push(...spies);

  const results: TypesafeResult<unknown>[] = [];

  const ok = harness([okResponse({ q: { type: "noul", noul: 0.5 } })]);
  results.push(await ok.client.evaluate({ state: "s", questions: { q: noul("i") } }));

  const secret = harness([
    new Response(JSON.stringify({ detail: "SECRET-STATE-MARKER" }), { status: 422 }),
  ]);
  results.push(await secret.client.evaluate({ state: "s", questions: { q: noul("i") } }));

  const down = harness([new TypeError("down"), new TypeError("down"), new TypeError("down")]);
  results.push(await down.client.evaluate({ state: "s", questions: { q: noul("i") } }));

  for (const spy of spies) {
    expect(spy).toHaveBeenCalledTimes(0);
  }
  expect(JSON.stringify(results)).not.toContain("SECRET-STATE-MARKER");
});
