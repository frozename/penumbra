import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import { expect, test } from "bun:test";
import { createJudgePool, type JudgeEntry } from "../src/workers/t2-judge-pool.js";

function makeJudge(name: string, baseUrl: string, model = "judge-model"): JudgeEntry {
  return { name, baseUrl, apiKey: "", model };
}

test("round-robin distributes calls across two healthy judges", async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a"), makeJudge("b", "http://b")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any, init: any) => {
      const body = JSON.parse(init?.body as string);
      seen.push(String(url).includes("http://a") ? "a" : "b");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        { status: 200 },
      );
    },
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
    fetch: async (url: any) => {
      const which = String(url).includes("http://a") ? "a" : "b";
      seen.push(which);
      if (which === "a") throw new Error("a-fail");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        { status: 200 },
      );
    },
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
    fetch: async (url: any) => {
      const which = String(url).includes("http://a") ? "a" : "b";
      seen.push(which);
      if (which === "a" && aShouldFail) throw new Error("a-fail");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        { status: 200 },
      );
    },
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
    fetch: async () => {
      throw new Error("fetch failed");
    },
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  await expect(pool.invoke("1")).rejects.toThrow("fetch failed");
  await expect(pool.invoke("2")).rejects.toThrow("all judges unhealthy this tick");
  await expect(pool.invoke("3")).rejects.toThrow("all judges unhealthy this tick");
});

test("single-judge pool degenerates to that one judge", async () => {
  const seen: string[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("a", "http://a")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: any, init: any) => {
      const body = JSON.parse(init?.body as string);
      seen.push(body.messages[0].content);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        { status: 200 },
      );
    },
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
    fetch: async (url: any) => {
      const which = String(url).includes("http://a") ? "a" : "b";
      seen.push(which);
      const content = which === "a" ? "not-json" : '{"memories":[]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    },
    unhealthyAfter: 1,
    promptBuilder: (transcript) => transcript,
    parseResponse: (rawContent) => {
      if (rawContent === "not-json") throw new Error("bad parse");
      return [];
    },
  });

  await expect(pool.invoke("x")).resolves.toEqual([]);
  await expect(pool.invoke("y")).resolves.toEqual([]);

  expect(seen).toEqual(["a", "b", "b"]);
});

test("judge caPath is plumbed into fetch tls.ca", async () => {
  const pemText = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
  const dir = mkdtempSync(join(tmpdir(), "t2-judge-pool-"));
  const caPath = join(dir, "judge-ca.pem");
  writeFileSync(caPath, pemText, "utf8");

  const seen: any[] = [];
  const pool = createJudgePool({
    judges: [
      { name: "with-ca", baseUrl: "http://a", apiKey: "", model: "judge-model", caPath },
      { name: "without-ca", baseUrl: "http://b", apiKey: "", model: "judge-model" },
    ],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (_url: any, init: any) => {
      seen.push(init);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        { status: 200 },
      );
    },
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
  const warnSpy: Array<Record<string, unknown>> = [];

  const pool = createJudgePool({
    judges: [
      { name: "a", baseUrl: "http://a", apiKey: "", model: "judge-model" },
      { name: "bad", baseUrl: "http://b", apiKey: "", model: "judge-model", caPath: badCaPath },
      { name: "c", baseUrl: "http://c", apiKey: "", model: "judge-model" },
    ],
    log: {
      info: () => undefined,
      warn: (...args: any[]) => {
        warnSpy.push(args[0] as Record<string, unknown>);
      },
      error: () => undefined,
    },
    fetch: async (_url: any) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), {
        status: 200,
      }),
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
  const warnSpy: Array<Record<string, unknown>> = [];

  expect(() =>
    createJudgePool({
      judges: [
        { name: "a", baseUrl: "http://a", apiKey: "", model: "judge-model", caPath: badPath },
        { name: "b", baseUrl: "http://b", apiKey: "", model: "judge-model", caPath: badPath },
        { name: "c", baseUrl: "http://c", apiKey: "", model: "judge-model", caPath: badPath },
      ],
      log: {
        info: () => undefined,
        warn: (...args: any[]) => {
          warnSpy.push(args[0] as Record<string, unknown>);
        },
        error: () => undefined,
      },
      fetch: async (_url: any) =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), {
          status: 200,
        }),
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

  const warnSpy: any[] = [];
  const pool = createJudgePool({
    judges: [makeJudge("slow-judge", `http://localhost:${server.port}`)],
    log: {
      info: () => undefined,
      warn: (...args: any[]) => warnSpy.push(args[0]),
      error: () => undefined,
    },
    timeoutMs: 10,
    unhealthyAfter: 2,
    promptBuilder: (t) => t,
    parseResponse: () => [],
  });

  await expect(pool.invoke("1")).rejects.toThrow(/judge slow-judge timed out after 10ms/i);

  expect(warnSpy.length).toBeGreaterThan(0);
  expect(warnSpy[0].err).toMatch(/timed out after 10ms/i);
  expect(warnSpy[0].judge).toBe("slow-judge");

  server.stop(true);
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

  const testEnv = async (val: string | undefined, expectTimeoutMs: number) => {
    const originalEnv = process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
    try {
      if (val === undefined) {
        delete process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
      } else {
        process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = val;
      }

      const pool = createJudgePool({
        judges: [makeJudge("env-judge", `http://localhost:${server.port}`)],
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        unhealthyAfter: 2,
        promptBuilder: (t) => t,
        parseResponse: () => [],
      });

      if (expectTimeoutMs < 50) {
        await expect(pool.invoke("1")).rejects.toThrow(
          new RegExp(`judge env-judge timed out after ${expectTimeoutMs}ms`, "i"),
        );
      } else {
        await expect(pool.invoke("1")).resolves.toEqual([]);
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

  server.stop(true);
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

    const pool = createJudgePool({
      judges: [makeJudge("override-judge", `http://localhost:${server.port}`)],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      timeoutMs: 10,
      unhealthyAfter: 2,
      promptBuilder: (t) => t,
      parseResponse: () => [],
    });

    await expect(pool.invoke("1")).rejects.toThrow(/judge override-judge timed out after 10ms/i);
    server.stop(true);
  } finally {
    if (originalEnv !== undefined) {
      process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
    }
  }
});
