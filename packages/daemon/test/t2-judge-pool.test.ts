import { serve } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createJudgePool,
  type JudgeEntry,
  type JudgePool,
  type JudgePoolOpts,
} from "../src/workers/t2-judge-pool.js";

type FetchMock = NonNullable<JudgePoolOpts["fetch"]>;
type FetchInput = Parameters<FetchMock>[0];
type FetchInitWithTls = RequestInit & { tls?: { ca?: string } };

const okJudgeResponse = (): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), {
    status: 200,
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const parsed = JSON.parse(init.body) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("expected JSON object request body");
  }
  return parsed;
}

function readPromptContent(init: RequestInit | undefined): string {
  const body = readRequestBody(init);
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    throw new Error("expected messages array");
  }
  const first = messages[0] as unknown;
  if (!isRecord(first) || typeof first.content !== "string") {
    throw new Error("expected first message content");
  }
  return first.content;
}

function logRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected log record");
  }
  return value;
}

function fetchInputText(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function serverPort(port: number | undefined): number {
  if (port === undefined) {
    throw new Error("test server did not expose a port");
  }
  return port;
}

async function expectInvokeToThrow(
  pool: JudgePool,
  transcript: string,
  expected: RegExp | string,
): Promise<void> {
  try {
    await pool.invoke(transcript);
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
    if (typeof expected === "string") {
      expect(err.message).toContain(expected);
    } else {
      expect(err.message).toMatch(expected);
    }
    return;
  }
  throw new Error("expected judge invocation to reject");
}

function makeJudge(name: string, baseUrl: string, model = "judge-model"): JudgeEntry {
  return { name, baseUrl, apiKey: "", model };
}

test("round-robin distributes calls across two healthy judges", async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a"), makeJudge("b", "http://b")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((url, init): Promise<Response> => {
      readRequestBody(init);
      seen.push(fetchInputText(url).includes("http://a") ? "a" : "b");
      return Promise.resolve(okJudgeResponse());
    }) satisfies FetchMock,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke("first");
  await pool.invoke("second");
  await pool.invoke("third");

  expect(seen).toEqual(["a", "b", "a"]);
});

test("judge that fails twice in a tick is skipped for the rest of that tick", async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a"), makeJudge("b", "http://b")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((url): Promise<Response> => {
      const which = fetchInputText(url).includes("http://a") ? "a" : "b";
      seen.push(which);
      if (which === "a") return Promise.reject(new Error("a-fail"));
      return Promise.resolve(okJudgeResponse());
    }) satisfies FetchMock,
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke("1");
  await pool.invoke("2");
  await pool.invoke("3");
  await pool.invoke("4");

  expect(seen).toEqual(["a", "b", "a", "b", "b", "b"]);
});

test("resetTickHealth re-enables a previously unhealthy judge", async () => {
  const seen: string[] = [];
  let aShouldFail = true;
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a"), makeJudge("b", "http://b")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((url): Promise<Response> => {
      const which = fetchInputText(url).includes("http://a") ? "a" : "b";
      seen.push(which);
      if (which === "a" && aShouldFail) return Promise.reject(new Error("a-fail"));
      return Promise.resolve(okJudgeResponse());
    }) satisfies FetchMock,
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke("1");
  await pool.invoke("2");
  seen.length = 0;
  await pool.invoke("3");
  expect(seen).toEqual(["b"]);

  pool.resetTickHealth();
  aShouldFail = false;
  seen.length = 0;
  await pool.invoke("4");
  expect(seen[0]).toBe("a");
});

test("all judges unhealthy this tick throws", async () => {
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a"), makeJudge("b", "http://b")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((): Promise<Response> => Promise.reject(new Error("fetch failed"))) satisfies FetchMock,
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await expectInvokeToThrow(pool, "1", "fetch failed");
  await expectInvokeToThrow(pool, "2", "all judges unhealthy this tick");
  await expectInvokeToThrow(pool, "3", "all judges unhealthy this tick");
});

test("single-judge pool degenerates to that one judge", async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((_url, init): Promise<Response> => {
      seen.push(readPromptContent(init));
      return Promise.resolve(okJudgeResponse());
    }) satisfies FetchMock,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke("1");
  await pool.invoke("2");
  await pool.invoke("3");

  expect(seen).toEqual(["1", "2", "3"]);
});

test("parseResponse error counts as judge failure", async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a"), makeJudge("b", "http://b")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((url): Promise<Response> => {
      const which = fetchInputText(url).includes("http://a") ? "a" : "b";
      seen.push(which);
      const content = which === "a" ? "not-json" : '{"memories":[]}';
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
      );
    }) satisfies FetchMock,
    unhealthyAfter: 1,
    promptBuilder: (transcript) => transcript,
    parseResponse: (rawContent) => {
      if (rawContent === "not-json") throw new Error("bad parse");
      return [];
    },
  });

  expect(await pool.invoke("x")).toEqual([]);
  expect(await pool.invoke("y")).toEqual([]);

  expect(seen).toEqual(["a", "b", "b"]);
});

test("judge caPath is plumbed into fetch tls.ca", async () => {
  const pemText = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
  const dir = mkdtempSync(join(tmpdir(), "t2-judge-pool-"));
  const caPath = join(dir, "judge-ca.pem");
  writeFileSync(caPath, pemText, "utf8");

  const seen: FetchInitWithTls[] = [];
  const pool = createJudgePool({
    judges: [
      { name: "with-ca", baseUrl: "http://a", apiKey: "", model: "judge-model", caPath },
      { name: "without-ca", baseUrl: "http://b", apiKey: "", model: "judge-model" },
    ],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: ((_url, init): Promise<Response> => {
      if (init === undefined) {
        throw new Error("expected request init");
      }
      seen.push(init as FetchInitWithTls);
      return Promise.resolve(okJudgeResponse());
    }) satisfies FetchMock,
    unhealthyAfter: 1,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await pool.invoke("first");
  await pool.invoke("second");

  expect(seen[0]?.tls?.ca).toBe(pemText);
  expect(seen[1]?.tls).toBeUndefined();

  rmSync(dir, { recursive: true, force: true });
});

test("judge pool init skips one bad caPath and keeps healthy judges", () => {
  const dir = mkdtempSync(join(tmpdir(), "t2-judge-pool-init-"));
  const badCaPath = join(dir, "missing.pem");
  const warnSpy: Record<string, unknown>[] = [];

  const pool = createJudgePool({
    judges: [
      { name: "a", baseUrl: "http://a", apiKey: "", model: "judge-model" },
      { name: "bad", baseUrl: "http://b", apiKey: "", model: "judge-model", caPath: badCaPath },
      { name: "c", baseUrl: "http://c", apiKey: "", model: "judge-model" },
    ],
    log: {
      info: () => undefined,
      warn: (...args: unknown[]): void => {
        warnSpy.push(logRecord(args[0]));
      },
      error: () => undefined,
    },
    fetch: ((): Promise<Response> => Promise.resolve(okJudgeResponse())) satisfies FetchMock,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  expect(pool.judgeCount()).toBe(2);
  expect(warnSpy).toHaveLength(1);
  expect(String(warnSpy[0]?.judge)).toBe("bad");
  expect(String(warnSpy[0]?.caPath)).toBe(badCaPath);

  rmSync(dir, { recursive: true, force: true });
});

test("judge pool init throws no_judges_available when all ca paths fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "t2-judge-pool-init-all-"));
  const badPath = join(dir, "missing.pem");
  const warnSpy: Record<string, unknown>[] = [];

  expect(() =>
    createJudgePool({
      judges: [
        { name: "a", baseUrl: "http://a", apiKey: "", model: "judge-model", caPath: badPath },
        { name: "b", baseUrl: "http://b", apiKey: "", model: "judge-model", caPath: badPath },
        { name: "c", baseUrl: "http://c", apiKey: "", model: "judge-model", caPath: badPath },
      ],
      log: {
        info: () => undefined,
        warn: (...args: unknown[]): void => {
          warnSpy.push(logRecord(args[0]));
        },
        error: () => undefined,
      },
      fetch: ((): Promise<Response> => Promise.resolve(okJudgeResponse())) satisfies FetchMock,
      promptBuilder: (transcript) => transcript,
      parseResponse: () => [],
    }),
  ).toThrow("no_judges_available");

  expect(warnSpy).toHaveLength(3);

  rmSync(dir, { recursive: true, force: true });
});

test("judge pool enforces programmatic timeout and reports failure correctly", async () => {
  const server = serve({
    port: 0,
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
      );
    },
  });

  const warnSpy: Record<string, unknown>[] = [];
  const port = serverPort(server.port);
  const pool = createJudgePool({
    judges: [makeJudge("slow-judge", `http://localhost:${String(port)}`)],
    log: {
      info: () => undefined,
      warn: (...args: unknown[]): void => {
        warnSpy.push(logRecord(args[0]));
      },
      error: () => undefined,
    },
    timeoutMs: 10,
    unhealthyAfter: 2,
    promptBuilder: (t) => t,
    parseResponse: () => [],
  });

  await expectInvokeToThrow(pool, "1", /judge slow-judge timed out after 10ms/i);

  expect(warnSpy.length).toBeGreaterThan(0);
  expect(String(warnSpy[0]?.err)).toMatch(/timed out after 10ms/i);
  expect(warnSpy[0].judge).toBe("slow-judge");

  await server.stop(true);
});

test("judge pool uses env timeout and parses values correctly", async () => {
  const server = serve({
    port: 0,
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
      );
    },
  });

  const port = serverPort(server.port);
  const testEnv = async (val: string | undefined, expectTimeoutMs: number): Promise<void> => {
    const originalEnv = process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
    try {
      if (val === undefined) {
        delete process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
      } else {
        process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = val;
      }

      const pool = createJudgePool({
        judges: [makeJudge("env-judge", `http://localhost:${String(port)}`)],
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        unhealthyAfter: 2,
        promptBuilder: (t) => t,
        parseResponse: () => [],
      });

      if (expectTimeoutMs < 50) {
        await expectInvokeToThrow(
          pool,
          "1",
          new RegExp(`judge env-judge timed out after ${String(expectTimeoutMs)}ms`, "i"),
        );
      } else {
        expect(await pool.invoke("1")).toEqual([]);
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = originalEnv;
      } else {
        delete process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
      }
    }
  };

  await testEnv("10", 10);

  await testEnv("abc", 900000);
  await testEnv("0", 900000);
  await testEnv("-5", 900000);
  await testEnv(undefined, 900000);

  await server.stop(true);
});

test("programmatic override beats env variable", async () => {
  const originalEnv = process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
  try {
    process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = "900000";

    const server = serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        );
      },
    });

    const port = serverPort(server.port);
    const pool = createJudgePool({
      judges: [makeJudge("override-judge", `http://localhost:${String(port)}`)],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      timeoutMs: 10,
      unhealthyAfter: 2,
      promptBuilder: (t) => t,
      parseResponse: () => [],
    });

    await expectInvokeToThrow(pool, "1", /judge override-judge timed out after 10ms/i);
    await server.stop(true);
  } finally {
    if (originalEnv !== undefined) {
      process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
    }
  }
});
