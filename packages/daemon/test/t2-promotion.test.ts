import { type Services, type T2MemoryExtraction } from "@penumbra/core";
import { serve } from "bun";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJudgePool, type JudgeEntry } from "../src/workers/t2-judge-pool.js";
import {
  createDefaultLLMJudge,
  createT2PromotionWorker,
  extractT2JudgeRequestExtras,
  parseJudgeResponse,
  resolveT2ExtractionJudge,
  stripJsonFence,
  wrapJudgeWithChunking,
} from "../src/workers/t2-promotion.js";
import { makeTempDaemon } from "./helpers.js";
import { serviceTest } from "./helpers/service-gates.js";

type T2Judge = (transcript: string) => Promise<T2MemoryExtraction[]>;

interface T2Embedder {
  name: string;
  dim: number;
  embed: (texts: string[]) => Promise<Float32Array[]>;
}

interface PromotionRow {
  t2_promoted_at: string | null;
  failed_promotion_attempts: number;
}
interface CountRow {
  c: number;
}

interface LoggerStub {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function serverPort(port: number | undefined): number {
  if (port === undefined) {
    throw new Error("test server did not expose a port");
  }
  return port;
}

// createDefaultLLMJudge only reads `services.log`. The full Services interface
// is nominally large but the SUT touches a narrow slice — fabricate a stub
// with one documented `as unknown as` so callers can supply only what's read.
function makeServicesStub(log: LoggerStub): Services {
  return { log } as unknown as Services;
}

// Pin PENUMBRA_CONFIG_DIR to a safe fixture config dir so the serve-internal
// t2-promotion worker created by makeTempDaemon() is always a no-op (dummy agent
// has no valid baseUrl → no eligible memory-refiner agents → pool returns null).
// This prevents the serve-internal initial tick from racing with tests that use
// an explicit llm mock and the same in-memory database.
let _fixtureDir: string;
const _savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  _fixtureDir = mkdtempSync(join(tmpdir(), "penumbra-t2-fixture-"));
  writeFileSync(
    join(_fixtureDir, "agents.yaml"),
    [
      "agents:",
      "  - name: dummy-judge",
      "    pricing_mode: api",
      "    adapter: openai-compat-http",
      "    api_provider: local",
      "    roles: [memory-refiner]",
      "",
    ].join("\n"),
  );
  writeFileSync(join(_fixtureDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(_fixtureDir, "quotas.yaml"), "providers: []\n");
  _savedEnv.agentchat = process.env.PENUMBRA_CONFIG_DIR;
  _savedEnv.judge = process.env.PENUMBRA_JUDGE_BASE_URL;
  _savedEnv.t2EmbedRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
  process.env.PENUMBRA_CONFIG_DIR = _fixtureDir;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "body_v1";
  delete process.env.PENUMBRA_JUDGE_BASE_URL;
});
afterAll(() => {
  if (_savedEnv.agentchat !== undefined) process.env.PENUMBRA_CONFIG_DIR = _savedEnv.agentchat;
  else delete process.env.PENUMBRA_CONFIG_DIR;
  if (_savedEnv.t2EmbedRecipe !== undefined)
    process.env.PENUMBRA_T2_EMBED_RECIPE = _savedEnv.t2EmbedRecipe;
  else delete process.env.PENUMBRA_T2_EMBED_RECIPE;
  if (_savedEnv.judge !== undefined) process.env.PENUMBRA_JUDGE_BASE_URL = _savedEnv.judge;
  rmSync(_fixtureDir, { recursive: true, force: true });
});

test("stripJsonFence strips think tags before plain JSON", () => {
  expect(stripJsonFence('<think>foo</think>{"memories":[]}')).toBe('{"memories":[]}');
});

test("stripJsonFence strips multiline think tags before plain JSON", () => {
  expect(stripJsonFence('<think>multi\nline</think>{"memories":[]}')).toBe('{"memories":[]}');
});

test("stripJsonFence strips think tags before a fenced JSON block", () => {
  expect(stripJsonFence('<think>foo</think>```json\n{"memories":[]}\n```')).toBe('{"memories":[]}');
});

test("stripJsonFence leaves plain JSON unchanged", () => {
  expect(stripJsonFence('{"memories":[]}')).toBe('{"memories":[]}');
});

test("stripJsonFence strips literal ESC[Nm sequences before JSON", () => {
  expect(stripJsonFence('\x1b[2m{"memories":[]}')).toBe('{"memories":[]}');
});

test("stripJsonFence strips bare bracket CSI sequences", () => {
  expect(stripJsonFence('[2m{"memories":[]}')).toBe('{"memories":[]}');
});

test("stripJsonFence preserves bracket-like substrings inside JSON values", () => {
  const parsed = JSON.parse(
    stripJsonFence('{"memories":[{"title":"see [2 lines below]","body":"x","kind":"fact"}]}'),
  ) as { memories: { title: string }[] };

  expect(parsed.memories[0]!.title).toBe("see [2 lines below]");
});

test("stripJsonFence extracts JSON wrapped in arbitrary tags (prompt-injected wrapper)", () => {
  // Surfaced by claude-mem transcripts that instruct responses be wrapped in <summary>...</summary>.
  // Granite faithfully follows the injected instruction and wraps the JSON; we recover by extracting
  // the {...} span instead of failing on the leading tag.
  expect(
    stripJsonFence('<summary>\n{"memories":[{"title":"x","body":"y","kind":"fact"}]}\n</summary>'),
  ).toBe('{"memories":[{"title":"x","body":"y","kind":"fact"}]}');
});

test("stripJsonFence handles unmatched leading tag with trailing prose", () => {
  expect(stripJsonFence('<observation>{"memories":[]}</observation>')).toBe('{"memories":[]}');
});

test('stripJsonFence coerces single-word "none"/"null" to empty memories', () => {
  // Granite-8B sometimes emits a literal "none" instead of {"memories":[]}
  // when it decides nothing should be extracted. The coercion lets the
  // caller treat that as a valid empty result.
  expect(stripJsonFence("none")).toBe('{"memories":[]}');
  expect(stripJsonFence("None.")).toBe('{"memories":[]}');
  expect(stripJsonFence("null")).toBe('{"memories":[]}');
  expect(stripJsonFence("N/A")).toBe('{"memories":[]}');
  expect(stripJsonFence("nothing")).toBe('{"memories":[]}');
});

test("wrapJudgeWithChunking passes small transcripts through unchanged", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      return Promise.resolve([]);
    },
  });

  const transcript = "User: hello\n\nAssistant: world";
  await judge(transcript);
  expect(seen).toEqual([transcript]);
});

test("wrapJudgeWithChunking splits at event boundaries when transcript exceeds budget", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 32000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      return Promise.resolve([]);
    },
  });

  const event = (role: string, body: string): string => `${role}: ${body}`;
  const transcript = Array.from({ length: 10 }, (_, i) =>
    event(i % 2 === 0 ? "User" : "Assistant", "x".repeat(15000)),
  ).join("\n\n");

  await judge(transcript);
  expect(seen.length).toBeGreaterThan(1);
  for (const chunk of seen) {
    expect(chunk.length).toBeLessThanOrEqual(32000);
    expect(chunk.startsWith("User: ") || chunk.startsWith("Assistant: ")).toBe(true);
    expect(chunk).not.toContain("x".repeat(15000) + "\n\nx".repeat(15000));
  }
});

test("wrapJudgeWithChunking dedupes by title", async () => {
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      if (transcript.includes("aaa")) {
        return Promise.resolve([{ title: "Duplicate", body: "one", kind: "fact" }]);
      }
      return Promise.resolve([{ title: "duplicate", body: "two", kind: "fact" }]);
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");

  expect(await judge(transcript)).toEqual([{ title: "Duplicate", body: "one", kind: "fact" }]);
});

test("wrapJudgeWithChunking collapses near-duplicates via embedding similarity (longer body wins)", async () => {
  // Two near-duplicate titles + bodies that map to nearly identical vectors;
  // a third semantically distinct memory survives untouched.
  const dim = 4;
  const dupeVec = new Float32Array([1, 0, 0, 0]);
  const dupeVecJittered = new Float32Array([0.99, 0.01, 0, 0]);
  const distinctVec = new Float32Array([0, 1, 0, 0]);
  const embedderMap = new Map<string, Float32Array>([
    ["short body", dupeVec],
    ["this is a longer body about the same thing", dupeVecJittered],
    ["totally separate topic body", distinctVec],
  ]);
  const embedder: T2Embedder = {
    name: "fake",
    dim,
    embed: (texts: string[]): Promise<Float32Array[]> =>
      Promise.resolve(texts.map((t) => embedderMap.get(t) ?? new Float32Array(dim))),
  };

  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    embedder,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      if (transcript.includes("aaa")) {
        return Promise.resolve([
          { title: "thing A", body: "short body", kind: "fact" },
          { title: "distinct", body: "totally separate topic body", kind: "fact" },
        ]);
      }
      return Promise.resolve([
        { title: "thing B", body: "this is a longer body about the same thing", kind: "fact" },
      ]);
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
  const out = await judge(transcript);
  // Two clusters: the near-dupe pair collapses to the longer-body rep, and the distinct one remains.
  expect(out.length).toBe(2);
  const bodies = out.map((m) => m.body).sort();
  expect(bodies).toEqual(
    ["this is a longer body about the same thing", "totally separate topic body"].sort(),
  );
});

test("wrapJudgeWithChunking keeps semantically distinct memories under similarity threshold", async () => {
  const dim = 3;
  const vecs = new Map<string, Float32Array>([
    ["alpha body", new Float32Array([1, 0, 0])],
    ["beta body", new Float32Array([0, 1, 0])],
    ["gamma body", new Float32Array([0, 0, 1])],
  ]);
  const embedder: T2Embedder = {
    name: "fake",
    dim,
    embed: (texts: string[]): Promise<Float32Array[]> =>
      Promise.resolve(texts.map((t) => vecs.get(t) ?? new Float32Array(dim))),
  };
  let call = 0;
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    embedder,
    judge: (): Promise<T2MemoryExtraction[]> => {
      call++;
      if (call === 1) {
        return Promise.resolve([
          { title: "A", body: "alpha body", kind: "fact" },
          { title: "B", body: "beta body", kind: "fact" },
        ]);
      }
      return Promise.resolve([{ title: "C", body: "gamma body", kind: "fact" }]);
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
  const out = await judge(transcript);
  expect(out.length).toBe(3);
  expect(out.map((m) => m.title)).toEqual(["A", "B", "C"]);
});

test("wrapJudgeWithChunking falls back to title-only dedupe when no embedder is provided", async () => {
  // Without an embedder the legacy title-match-only behavior applies; near-duplicate titles
  // that differ in casing collapse, but distinct titles survive even with similar bodies.
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      if (transcript.includes("aaa")) {
        return Promise.resolve([
          { title: "X", body: "one body that talks about the same thing", kind: "fact" },
        ]);
      }
      return Promise.resolve([
        { title: "Y", body: "one body that talks about the same thing", kind: "fact" },
      ]);
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
  const out = await judge(transcript);
  // No embedder ⇒ both survive even though bodies are identical.
  expect(out.length).toBe(2);
  expect(out.map((m) => m.title)).toEqual(["X", "Y"]);
});

test("wrapJudgeWithChunking uses body-v1 embed text by default (inert-default)", async () => {
  const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
  delete process.env.PENUMBRA_T2_EMBED_RECIPE;
  const seen: string[][] = [];
  const embedder: T2Embedder = {
    name: "spy",
    dim: 4,
    embed: (texts: string[]): Promise<Float32Array[]> => {
      seen.push(texts);
      return Promise.resolve(texts.map(() => new Float32Array([1, 0, 0, 0])));
    },
  };

  try {
    const judge = wrapJudgeWithChunking({
      maxCharsPerChunk: 20,
      embedder,
      judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
        if (transcript.includes("aaa")) {
          return Promise.resolve([{ title: "Alpha title", body: "Alpha body", kind: "fact" }]);
        }
        return Promise.resolve([{ title: "Beta title", body: "Beta body", kind: "fact" }]);
      },
    });

    const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
    await judge(transcript);
    expect(seen).toEqual([["Alpha body", "Beta body"]]);
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
  }
});

test("wrapJudgeWithChunking routes embed input through title recipe when enabled", async () => {
  const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "title_only";
  const seen: string[][] = [];
  const embedder: T2Embedder = {
    name: "spy",
    dim: 4,
    embed: (texts: string[]): Promise<Float32Array[]> => {
      seen.push(texts);
      return Promise.resolve(texts.map(() => new Float32Array([1, 0, 0, 0])));
    },
  };

  try {
    const judge = wrapJudgeWithChunking({
      maxCharsPerChunk: 20,
      embedder,
      judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
        if (transcript.includes("aaa")) {
          return Promise.resolve([{ title: "Alpha title", body: "Alpha body", kind: "fact" }]);
        }
        return Promise.resolve([{ title: "Beta title", body: "Beta body", kind: "fact" }]);
      },
    });

    const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
    await judge(transcript);
    expect(seen).toEqual([["Alpha title", "Beta title"]]);
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
  }
});

test("wrapJudgeWithChunking continues when one chunk fails", async () => {
  let call = 0;
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 60,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      call++;
      if (transcript.includes("c".repeat(20))) throw new Error("chunk 2 failed");
      return Promise.resolve([{ title: `t${String(call)}`, body: "body", kind: "fact" }]);
    },
  });

  const transcript = [
    "User: " + "a".repeat(20),
    "Assistant: " + "b".repeat(20),
    "User: " + "c".repeat(20),
    "Assistant: " + "d".repeat(20),
    "User: " + "e".repeat(20),
    "Assistant: " + "f".repeat(20),
  ].join("\n\n");

  expect(await judge(transcript)).toEqual([
    { title: "t1", body: "body", kind: "fact" },
    { title: "t2", body: "body", kind: "fact" },
    { title: "t4", body: "body", kind: "fact" },
    { title: "t5", body: "body", kind: "fact" },
    { title: "t6", body: "body", kind: "fact" },
  ]);
});

test("wrapJudgeWithChunking preserves order of extractions across chunks", async () => {
  let call = 0;
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    judge: (): Promise<T2MemoryExtraction[]> => {
      call++;
      return Promise.resolve(
        call === 1
          ? [{ title: "A", body: "body-a", kind: "fact" }]
          : [{ title: "B", body: "body-b", kind: "fact" }],
      );
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");

  expect(await judge(transcript)).toEqual([
    { title: "A", body: "body-a", kind: "fact" },
    { title: "B", body: "body-b", kind: "fact" },
  ]);
});

test("extractT2JudgeRequestExtras accepts only plain requestExtras objects", () => {
  expect(
    extractT2JudgeRequestExtras({
      requestExtras: { max_tokens: 64, chat_template_kwargs: { enable_thinking: false } },
    }),
  ).toEqual({ max_tokens: 64, chat_template_kwargs: { enable_thinking: false } });
  expect(extractT2JudgeRequestExtras({ requestExtras: null })).toBeUndefined();
  expect(extractT2JudgeRequestExtras({ requestExtras: ["bad"] })).toBeUndefined();
  expect(extractT2JudgeRequestExtras({ requestExtras: new Date() })).toBeUndefined();
});

serviceTest(
  "t2 promotion worker is a no-op when no LLM judge is configured (no PENUMBRA_JUDGE_BASE_URL)",
  async () => {
    const d = makeTempDaemon();
    d.services.supervisor.stopAll();
    const dir = mkdtempSync(join(tmpdir(), "penumbra-agentchat-empty-"));
    // Empty agents list so the pool path also returns null and the worker
    // falls all the way through to no-op.
    writeFileSync(
      join(dir, "agents.yaml"),
      [
        "agents:",
        "  - name: dummy-judge",
        "    pricing_mode: api",
        "    adapter: openai-compat-http",
        "    api_provider: local",
        "    roles: [memory-refiner]",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
    writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
    const oldEnv = {
      judge: process.env.PENUMBRA_JUDGE_BASE_URL,
      agentchat: process.env.PENUMBRA_CONFIG_DIR,
    };
    delete process.env.PENUMBRA_JUDGE_BASE_URL;
    process.env.PENUMBRA_CONFIG_DIR = dir;
    try {
      const oldTs = "2026-04-20T00:00:00.000Z";
      d.services.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
       VALUES ('rno', 'p1', 'u1', 'sno', ?, ?, 5, '{}', '{}')`,
        [oldTs, oldTs],
      );
      d.services.clock = (): Date => new Date("2026-04-27T10:00:00Z");

      // No `llm` opt — exercises createDefaultLLMJudge which returns null when env unset.
      const worker = createT2PromotionWorker({ services: d.services, delayHours: 24 });
      expect(worker.status).toEqual({
        enabled: false,
        reason: "judge_unconfigured",
        judge_env: "PENUMBRA_JUDGE_BASE_URL",
      });
      await worker.tick();

      // Rollup is untouched: not promoted, no failure counter increment.
      const row = d.services.db
        .query<
          PromotionRow,
          []
        >(`SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id='rno'`)
        .get();
      expect(row?.t2_promoted_at).toBeNull();
      expect(row?.failed_promotion_attempts).toBe(0);
    } finally {
      if (oldEnv.judge) process.env.PENUMBRA_JUDGE_BASE_URL = oldEnv.judge;
      if (oldEnv.agentchat) process.env.PENUMBRA_CONFIG_DIR = oldEnv.agentchat;
      else delete process.env.PENUMBRA_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
      d.stop();
    }
  },
);

test("agentchat-based pool passes requestExtras from memory-refiner agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-agentchat-"));
  const oldConfig = process.env.PENUMBRA_CONFIG_DIR;
  const oldSirius = process.env.PENUMBRA_JUDGE_BASE_URL;
  const seenBodies: Record<string, unknown>[] = [];
  const server = serve({
    port: 0,
    async fetch(req) {
      const parsed = await req.json();
      if (!isRecord(parsed)) {
        throw new Error("expected JSON object request body");
      }
      seenBodies.push(parsed);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        { status: 200 },
      );
    },
  });
  const port = serverPort(server.port);
  delete process.env.PENUMBRA_JUDGE_BASE_URL;
  process.env.PENUMBRA_CONFIG_DIR = dir;
  writeFileSync(
    join(dir, "agents.yaml"),
    `
agents:
  - name: judge-a
    adapter: openai-compat-http
    api_provider: local
    options:
      baseUrl: http://localhost:${String(port)}
      model: granite
      requestExtras:
        max_tokens: 64
        chat_template_kwargs:
          enable_thinking: false
    roles: [memory-refiner]
  - name: judge-b
    adapter: openai-compat-http
    api_provider: local
    options:
      baseUrl: http://judge-b
      model: gemma
    roles: [memory-refiner]
`,
  );
  writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
  try {
    const judge = resolveT2ExtractionJudge(
      makeServicesStub({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    );
    if (!judge) {
      throw new Error("expected agentchat judge pool");
    }

    await judge("transcript");

    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]?.max_tokens).toBe(64);
    expect(seenBodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
  } finally {
    await server.stop(true);
    if (oldConfig) process.env.PENUMBRA_CONFIG_DIR = oldConfig;
    else delete process.env.PENUMBRA_CONFIG_DIR;
    if (oldSirius) process.env.PENUMBRA_JUDGE_BASE_URL = oldSirius;
    else delete process.env.PENUMBRA_JUDGE_BASE_URL;
    rmSync(dir, { recursive: true, force: true });
  }
});

serviceTest("worker falls back to single-judge env config when no memory-refiner agents", () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  const dir = mkdtempSync(join(tmpdir(), "penumbra-agentchat-"));
  const oldConfig = process.env.PENUMBRA_CONFIG_DIR;
  const oldSirius = process.env.PENUMBRA_JUDGE_BASE_URL;
  const oldToken = process.env.PENUMBRA_JUDGE_TOKEN;
  process.env.PENUMBRA_CONFIG_DIR = dir;
  process.env.PENUMBRA_JUDGE_BASE_URL = "http://judge";
  process.env.PENUMBRA_JUDGE_TOKEN = "token";
  writeFileSync(
    join(dir, "agents.yaml"),
    `
agents:
  - name: planner
    adapter: openai-compat-http
    api_provider: local
    options:
      baseUrl: http://planner
      model: granite
    roles: [planner]
`,
  );
  writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
  const infoSpy = spyOn(d.services.log, "info").mockImplementation(() => undefined);
  try {
    createT2PromotionWorker({ services: d.services, delayHours: 24 });
    expect(
      infoSpy.mock.calls.some((call) => String(call[1]).includes("LLM judge configured")),
    ).toBe(true);
  } finally {
    infoSpy.mockRestore();
    if (oldConfig) process.env.PENUMBRA_CONFIG_DIR = oldConfig;
    else delete process.env.PENUMBRA_CONFIG_DIR;
    if (oldSirius) process.env.PENUMBRA_JUDGE_BASE_URL = oldSirius;
    else delete process.env.PENUMBRA_JUDGE_BASE_URL;
    if (oldToken) process.env.PENUMBRA_JUDGE_TOKEN = oldToken;
    else delete process.env.PENUMBRA_JUDGE_TOKEN;
    rmSync(dir, { recursive: true, force: true });
    d.stop();
  }
});

serviceTest("t2 promotion worker short-circuits the cycle when judge is unreachable", async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  d.services.clock = (): Date => new Date("2026-04-27T10:00:00Z");
  try {
    const oldTs = "2026-04-20T00:00:00.000Z";
    // Three eligible rollups; first call should fail unreachable and remaining should be skipped.
    for (const id of ["ru1", "ru2", "ru3"]) {
      d.services.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
         VALUES (?, 'p1', 'u1', ?, ?, ?, 5, '{}', '{}')`,
        [id, `s_${id}`, oldTs, oldTs],
      );
      d.services.db.run(
        `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
         VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
        [`e_${id}`, oldTs, oldTs, `s_${id}`],
      );
    }

    let callCount = 0;
    const llm: T2Judge = () => {
      callCount++;
      throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:3030");
    };
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm,
    });

    await worker.tick();
    // Only the first rollup attempt should hit the judge — remaining two are short-circuited.
    expect(callCount).toBe(1);
  } finally {
    d.stop();
  }
});

serviceTest("t2 promotion worker skips on LLM failure but retries next tick", async () => {
  const d = makeTempDaemon();
  // Fixed clock for deterministic eligibility
  const now = new Date("2026-04-27T10:00:00Z");
  d.services.clock = (): Date => now;
  // Stop background workers to avoid interference
  d.services.supervisor.stopAll();

  try {
    // Seed a rollup that is eligible for promotion
    const oldTs = "2026-04-20T00:00:00.000Z";
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
      [oldTs, oldTs],
    );
    // Add events so transcript is not empty
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
      [oldTs, oldTs],
    );

    let callCount = 0;
    const llm: T2Judge = () => {
      callCount++;
      throw new Error("LLM down");
    };
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm,
    });

    await worker.tick();
    expect(callCount).toBe(1);

    // Should not be promoted
    const promoted = d.services.db
      .query<
        PromotionRow,
        []
      >('SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"')
      .get();
    expect(promoted?.t2_promoted_at).toBeNull();
    expect(promoted?.failed_promotion_attempts).toBe(1);

    // Retry
    await worker.tick();
    expect(callCount).toBe(2);
    const promoted2 = d.services.db
      .query<
        Pick<PromotionRow, "failed_promotion_attempts">,
        []
      >('SELECT failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"')
      .get();
    expect(promoted2?.failed_promotion_attempts).toBe(2);
  } finally {
    d.stop();
  }
});

serviceTest("t2 promotion worker promotes eligible rollups", async () => {
  const d = makeTempDaemon();
  const now = new Date("2026-04-27T10:00:00Z");
  d.services.clock = (): Date => now;
  d.services.supervisor.stopAll();

  try {
    const oldTs = "2026-04-20T00:00:00.000Z";
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
      [oldTs, oldTs],
    );
    // Add events so transcript is not empty
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
      [oldTs, oldTs],
    );

    const llm: T2Judge = () =>
      Promise.resolve([{ title: "Greet", body: "User said hello", kind: "fact" }]);
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm,
    });

    await worker.tick();

    const count = d.services.db.query<CountRow, []>("SELECT COUNT(*) c FROM t2_memories").get();
    expect(count?.c).toBe(1);

    const promoted = d.services.db
      .query<
        PromotionRow,
        []
      >('SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"')
      .get();
    expect(promoted?.t2_promoted_at).not.toBeNull();
    expect(promoted?.failed_promotion_attempts).toBe(0);
  } finally {
    d.stop();
  }
});

serviceTest("t2 promotion worker handles empty transcripts by marking as promoted", async () => {
  const d = makeTempDaemon();
  const now = new Date("2026-04-27T10:00:00Z");
  d.services.clock = (): Date => now;
  d.services.supervisor.stopAll();

  try {
    const oldTs = "2026-04-20T00:00:00.000Z";
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
      [oldTs, oldTs],
    );
    // No events or only whitespace events
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', '   ')`,
      [oldTs, oldTs],
    );

    const llm: T2Judge = () => {
      throw new Error("Should not be called");
    };
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm,
    });

    await worker.tick();

    const count = d.services.db.query<CountRow, []>("SELECT COUNT(*) c FROM t2_memories").get();
    expect(count?.c).toBe(0);

    const promoted = d.services.db
      .query<
        Pick<PromotionRow, "t2_promoted_at">,
        []
      >('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id="r1"')
      .get();
    expect(promoted?.t2_promoted_at).not.toBeNull();
  } finally {
    d.stop();
  }
});

serviceTest(
  "t2 promotion worker fails on malformed LLM response and increments counter",
  async () => {
    const d = makeTempDaemon();
    const now = new Date("2026-04-27T10:00:00Z");
    d.services.clock = (): Date => now;
    d.services.supervisor.stopAll();

    try {
      const oldTs = "2026-04-20T00:00:00.000Z";
      d.services.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
        [oldTs, oldTs],
      );
      d.services.db.run(
        `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
        [oldTs, oldTs],
      );

      // title is empty string — fails schema's min(1) at runtime. TS-level the
      // shape still satisfies T2MemoryExtraction (title: string), so no cast is
      // required to fabricate the malformed payload.
      const llm: T2Judge = () =>
        Promise.resolve([{ title: "", body: "missing title", kind: "fact" }]);
      const worker = createT2PromotionWorker({
        services: d.services,
        delayHours: 24,
        llm,
      });

      await worker.tick();

      const count = d.services.db.query<CountRow, []>("SELECT COUNT(*) c FROM t2_memories").get();
      expect(count?.c).toBe(0);

      const promoted = d.services.db
        .query<
          PromotionRow,
          []
        >('SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"')
        .get();
      expect(promoted?.t2_promoted_at).toBeNull();
      expect(promoted?.failed_promotion_attempts).toBe(1);
    } finally {
      d.stop();
    }
  },
);

serviceTest("t2 promotion worker stops retrying after limit", async () => {
  const d = makeTempDaemon();
  const now = new Date("2026-04-27T10:00:00Z");
  d.services.clock = (): Date => now;
  d.services.supervisor.stopAll();

  try {
    const oldTs = "2026-04-20T00:00:00.000Z";
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json, failed_promotion_attempts)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 1, '{}', '{}', 5)`,
      [oldTs, oldTs],
    );
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
      [oldTs, oldTs],
    );

    let callCount = 0;
    const llm: T2Judge = () => {
      callCount++;
      return Promise.resolve([]);
    };
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm,
    });

    await worker.tick();
    // Should skip because attempts=5
    expect(callCount).toBe(0);
  } finally {
    d.stop();
  }
});

serviceTest("t2 promotion worker defaults minEvents to 5", async () => {
  const d = makeTempDaemon();
  const now = new Date("2026-04-27T10:00:00Z");
  d.services.clock = (): Date => now;
  d.services.supervisor.stopAll();

  try {
    const oldTs = "2026-04-20T00:00:00.000Z";
    // Rollup with 3 events
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 3, '{}', '{}')`,
      [oldTs, oldTs],
    );
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
      [oldTs, oldTs],
    );

    let callCount = 0;
    const llm: T2Judge = () => {
      callCount++;
      return Promise.resolve([{ title: "Fact", body: "Fact", kind: "fact" }]);
    };
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm,
    });

    await worker.tick();
    expect(callCount).toBe(0);
  } finally {
    d.stop();
  }
});

serviceTest("t2 promotion worker respects configured minEvents override", async () => {
  const d = makeTempDaemon();
  const now = new Date("2026-04-27T10:00:00Z");
  d.services.clock = (): Date => now;
  d.services.supervisor.stopAll();

  try {
    const oldTs = "2026-04-20T00:00:00.000Z";
    // Rollup with 3 events
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 3, '{}', '{}')`,
      [oldTs, oldTs],
    );
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'Session transcript for promotion test. The assistant worked through multiple software implementation tasks, reviewed and approved code changes, wrote and verified tests, and confirmed that multiple system components worked correctly in integration.')`,
      [oldTs, oldTs],
    );

    let callCount = 0;
    const llm: T2Judge = () => {
      callCount++;
      return Promise.resolve([{ title: "Fact", body: "Fact", kind: "fact" }]);
    };
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      minEvents: 2,
      llm,
    });

    await worker.tick();
    expect(callCount).toBe(1);
    const count = d.services.db.query<CountRow, []>("SELECT COUNT(*) c FROM t2_memories").get();
    expect(count?.c).toBe(1);
  } finally {
    d.stop();
  }
});

test("wrapJudgeWithChunking env override PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK", async () => {
  const prev = process.env.PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK;
  process.env.PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK = "50";
  try {
    const seen: string[] = [];
    // Omit maxCharsPerChunk so it uses env
    const judge = wrapJudgeWithChunking({
      judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
        seen.push(transcript);
        return Promise.resolve([]);
      },
    });

    // 60 chars > 50 char limit.
    const transcript = ["User: " + "a".repeat(20), "Assistant: " + "b".repeat(20)].join("\n\n");
    await judge(transcript);

    // Each string + role is around 26 chars. 26+2+26 > 50, so should be split.
    expect(seen.length).toBeGreaterThan(1);
    for (const chunk of seen) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK;
    else process.env.PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK = prev;
  }
});

test("wrapJudgeWithChunking oversized event hard split", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 50,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      return Promise.resolve([]);
    },
  });

  // A single event of 120 chars. It should be hard split into lengths of 50.
  const transcript = "User: " + "a".repeat(114);
  await judge(transcript);

  expect(seen.length).toBe(3);
  expect(seen[0]!.length).toBe(50);
  expect(seen[1]!.length).toBe(50);
  expect(seen[2]!.length).toBe(20);
});

test("wrapJudgeWithChunking halves and retries on context overflow", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 10000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      if (transcript.length > 5000) {
        throw new Error("exceeds the available context size");
      }
      return Promise.resolve([
        {
          title: "Found " + transcript.substring(0, 10),
          body: transcript.substring(0, 10),
          kind: "fact",
        },
      ]);
    },
  });

  const event1 = "User: " + "a".repeat(3000);
  const event2 = "Assistant: " + "b".repeat(3000);
  const transcript = [event1, event2].join("\n\n");

  // transcript is ~6020 chars. It fits in maxCharsPerChunk (10000) so it's a single chunk initially.
  // judge throws context size error. It should halve on event boundaries and retry.
  const res = await judge(transcript);

  expect(seen.length).toBe(3); // 1 initial fail, 2 success on halves
  expect(seen[0]).toBe(transcript);
  expect(seen[1]).toBe(event1);
  expect(seen[2]).toBe(event2);
  expect(res.length).toBe(2);
});

test("wrapJudgeWithChunking recursion floor gives up cleanly", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 10000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      // always throw context size error
      throw new Error("exceed_context_size_error");
    },
  });

  // Small enough that after a split, length will be < 4000 and it will hit the floor.
  const transcript = "User: " + "a".repeat(4500);

  const res = await judge(transcript);

  // 1 initial try, it halves to ~2250, then retries those 2.
  // Those 2 will also fail and check length < 4000, and drop the chunk without further retries.
  expect(seen.length).toBe(3);
  expect(res.length).toBe(0);
});

test("wrapJudgeWithChunking handles exceed-context retry within a chunked path", async () => {
  let calls = 0;
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 10000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      calls++;
      seen.push(transcript);
      // Fails only on the first combined chunk (length ~8000), succeeds on its halves (~4000)
      if (transcript.includes("fail_marker") && transcript.length > 5000) {
        throw new Error("exceeds the available context size");
      }
      return Promise.resolve([
        {
          title: "Found " + transcript.substring(0, 10).trim(),
          body: transcript.substring(0, 10).trim(),
          kind: "fact",
        },
      ]);
    },
  });

  const event1 = "User: fail_marker " + "a".repeat(4000);
  const event2 = "Assistant: " + "b".repeat(4000);
  const event3 = "User: " + "c".repeat(4000);
  const event4 = "Assistant: " + "d".repeat(4000);

  const transcript = [event1, event2, event3, event4].join("\n\n");

  // Verify the transcript is long enough to hit the chunked path
  expect(transcript.length).toBeGreaterThan(10000);

  const res = await judge(transcript);

  const chunk1 = [event1, event2].join("\n\n");
  const chunk2 = [event3, event4].join("\n\n");

  expect(calls).toBe(4);
  expect(seen.length).toBe(4);
  expect(seen[0]).toBe(chunk1);
  expect(seen[1]).toBe(event1);
  expect(seen[2]).toBe(event2);
  expect(seen[3]).toBe(chunk2);

  expect(res.length).toBe(3);
  expect(res[0]!.title).toBe("Found User: fail");
  expect(res[1]!.title).toBe("Found Assistant:");
  expect(res[2]!.title).toBe("Found User: cccc");
});

test("createDefaultLLMJudge enforces PENUMBRA_T2_JUDGE_TIMEOUT_MS", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(100);
      return new Response("OK");
    },
  });
  const prevUrl = process.env.PENUMBRA_JUDGE_BASE_URL;
  const prevTimeout = process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
  process.env.PENUMBRA_JUDGE_BASE_URL = `http://localhost:${String(server.port)}`;
  process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = "50";
  try {
    const stub = makeServicesStub({
      info: () => undefined,
      error: () => undefined,
      warn: () => undefined,
    });
    const judge = createDefaultLLMJudge(stub);
    let caught: unknown;
    try {
      await judge!("transcript");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/judge default timed out after 50ms/);
  } finally {
    await server.stop(true);
    if (prevUrl === undefined) delete process.env.PENUMBRA_JUDGE_BASE_URL;
    else process.env.PENUMBRA_JUDGE_BASE_URL = prevUrl;
    if (prevTimeout === undefined) delete process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS;
    else process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS = prevTimeout;
  }
});

test("wrapJudgeWithChunking n_ctx-aware split uses ceil(n_prompt_tokens / (0.7 * effective_n_ctx)) pieces", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      if (transcript.length > 5000) {
        throw new Error(
          "request (10000 tokens) exceeds the available context size (8192 tokens) exceed_context_size_error n_prompt_tokens:10000 n_ctx:8192",
        );
      }
      return Promise.resolve([
        {
          title: "Found " + transcript.substring(0, 10).trim(),
          body: transcript.substring(0, 80).trim() || "body",
          kind: "fact",
        },
      ]);
    },
  });

  const events = Array.from(
    { length: 20 },
    (_, i) => `${i % 2 === 0 ? "User" : "Assistant"}: ${"a".repeat(400)}`,
  );
  const transcript = events.join("\n\n");

  await judge(transcript);

  expect(seen.length).toBe(3);
  expect(seen[0]).toBe(transcript);
  const splitPieces = seen.slice(1);
  expect(splitPieces.length).toBe(2);
  for (const piece of splitPieces) {
    expect(piece.length).toBeLessThanOrEqual(5000);
  }
});

test("wrapJudgeWithChunking falls back to halving when n_prompt_tokens/n_ctx absent", async () => {
  const seen: string[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      if (transcript.length > 5000) {
        throw new Error("exceeds the available context size");
      }
      return Promise.resolve([
        {
          title: "Found " + transcript.substring(0, 10).trim(),
          body: transcript.substring(0, 80).trim() || "body",
          kind: "fact",
        },
      ]);
    },
  });

  const events = Array.from(
    { length: 4 },
    (_, i) => `${i % 2 === 0 ? "User" : "Assistant"}: ${"a".repeat(2000)}`,
  );
  const transcript = events.join("\n\n");

  await judge(transcript);

  expect(seen.length).toBe(3);
  expect(seen[0]).toBe(transcript);
  expect(seen[1]).toBe(events.slice(0, 2).join("\n\n"));
  expect(seen[2]).toBe(events.slice(2).join("\n\n"));
});

test("wrapJudgeWithChunking maxChunks drops middle chunks (head/tail) and logs dropped count", async () => {
  const seen: string[] = [];
  const logCalls: { dropped?: number }[] = [];
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100,
    maxChunks: 4,
    log: {
      info: (...args: unknown[]): void => {
        const record = args[0];
        if (record && typeof record === "object" && "dropped" in record) {
          logCalls.push({ dropped: (record as { dropped: number }).dropped });
        }
      },
      warn: () => undefined,
    },
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => {
      seen.push(transcript);
      return Promise.resolve([
        {
          title: `t-${transcript.substring(0, 5)}`,
          body: "body that is long enough to pass the filter for sure without any issues here",
          kind: "fact",
        },
      ]);
    },
  });

  const events = Array.from({ length: 20 }, (_, i) => `User: ${"x".repeat(90)}s${String(i)}`);
  const transcript = events.join("\n\n");

  await judge(transcript);

  expect(seen.length).toBe(4);
  expect(logCalls.length).toBeGreaterThanOrEqual(1);
  expect(logCalls[0]?.dropped).toBeGreaterThan(0);
});

test("wrapJudgeWithChunking concurrency preserves output order by chunk index", async () => {
  let call = 0;
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    concurrency: 2,
    judge: (): Promise<T2MemoryExtraction[]> => {
      call++;
      return Promise.resolve(
        call === 1
          ? [
              {
                title: "A",
                body: "body-a that is long enough to pass the filter for sure",
                kind: "fact",
              },
            ]
          : call === 2
            ? [
                {
                  title: "B",
                  body: "body-b that is long enough to pass the filter for sure",
                  kind: "fact",
                },
              ]
            : [
                {
                  title: "C",
                  body: "body-c that is long enough to pass the filter for sure",
                  kind: "fact",
                },
              ],
      );
    },
  });

  const transcript = [
    "User: aaa",
    "Assistant: bbb",
    "User: ccc",
    "Assistant: ddd",
    "User: eee",
    "Assistant: fff",
  ].join("\n\n");
  const out = await judge(transcript);

  expect(out.length).toBe(3);
  expect(out.map((m) => m.title)).toEqual(["A", "B", "C"]);
});

test("wrapJudgeWithChunking failWhenAllChunksFail rethrows when set and all chunks fail with non-overflow", async () => {
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    failWhenAllChunksFail: true,
    judge: (): Promise<T2MemoryExtraction[]> => {
      throw new Error("backend offline");
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
  let caught: unknown;
  try {
    await judge(transcript);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("backend offline");
});

test("wrapJudgeWithChunking failWhenAllChunksFail=false swallows non-overflow errors (default)", async () => {
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 20,
    judge: (): Promise<T2MemoryExtraction[]> => {
      throw new Error("backend offline");
    },
  });

  const transcript = ["User: aaa", "Assistant: bbb", "User: ccc", "Assistant: ddd"].join("\n\n");
  const out = await judge(transcript);
  expect(out).toEqual([]);
});

test("a later rollup in the same tick is still judged after two overflows (pool not poisoned)", async () => {
  let call = 0;
  const makeJudgeEntry = (name: string, baseUrl: string): JudgeEntry => ({
    name,
    baseUrl,
    apiKey: "",
    model: "test-model",
  });
  const pool = createJudgePool({
    judges: [makeJudgeEntry("solo", "http://solo")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: (_url, init): Promise<Response> => {
      call++;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        messages?: { content?: string }[];
      };
      const content = body.messages?.[0]?.content ?? "";
      if (content.length > 5000) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                message:
                  "request (13857 tokens) exceeds the available context size (8192 tokens) exceed_context_size_error n_prompt_tokens:13857 n_ctx:8192",
                type: "exceed_context_size_error",
                n_prompt_tokens: 13857,
                n_ctx: 8192,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), {
          status: 200,
        }),
      );
    },
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });

  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => pool.invoke(transcript),
  });

  const largeTranscript = "User: " + "a".repeat(10000);
  const r1 = await judge(largeTranscript);
  expect(r1).toEqual([]);
  const r2 = await judge(largeTranscript);
  expect(r2).toEqual([]);
  const r3 = await judge(largeTranscript);
  expect(r3).toEqual([]);
});

test("wrapJudgeWithChunking caps total judge calls on hostile overflow metrics", async () => {
  let callCount = 0;
  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100000,
    failWhenAllChunksFail: true,
    judge: (): Promise<T2MemoryExtraction[]> => {
      callCount++;
      throw new Error(
        JSON.stringify({
          error: {
            type: "exceed_context_size_error",
            message: "context overflow",
            n_prompt_tokens: 1_000_000_000,
            n_ctx: 1,
          },
        }),
      );
    },
  });

  const transcript = "User: " + "a".repeat(10000);
  let caught: unknown;
  try {
    await judge(transcript);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(callCount).toBeLessThanOrEqual(12);
});

test("pool not poisoned: a tiny transcript after overflows yields a real memory candidate", async () => {
  let call = 0;
  const makeJudgeEntry = (name: string, baseUrl: string): JudgeEntry => ({
    name,
    baseUrl,
    apiKey: "",
    model: "test-model",
  });
  const pool = createJudgePool({
    judges: [makeJudgeEntry("solo", "http://solo")],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: (_url, init): Promise<Response> => {
      call++;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        messages?: { content?: string }[];
      };
      const content = body.messages?.[0]?.content ?? "";
      if (content.length > 5000) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                message:
                  "request (13857 tokens) exceeds the available context size (8192 tokens) exceed_context_size_error n_prompt_tokens:13857 n_ctx:8192",
                type: "exceed_context_size_error",
                n_prompt_tokens: 13857,
                n_ctx: 8192,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (content === "User: small") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      memories: [
                        {
                          title: "Tiny Candidate",
                          body: "A durable fact from a tiny transcript that proves the pool is still healthy after overflows.",
                          kind: "decision",
                          why: "Positive control for pool health after overflow exhaustion.",
                          depth: 2,
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }), {
          status: 200,
        }),
      );
    },
    unhealthyAfter: 2,
    promptBuilder: (transcript) => transcript,
    parseResponse: parseJudgeResponse,
  });

  const judge = wrapJudgeWithChunking({
    maxCharsPerChunk: 100000,
    judge: (transcript: string): Promise<T2MemoryExtraction[]> => pool.invoke(transcript),
  });

  const largeTranscript = "User: " + "a".repeat(10000);
  const r1 = await judge(largeTranscript);
  expect(r1).toEqual([]);
  const r2 = await judge(largeTranscript);
  expect(r2).toEqual([]);
  const r3 = await judge(largeTranscript);
  expect(r3).toEqual([]);
  const r4 = await judge("User: small");
  expect(r4.length).toBeGreaterThanOrEqual(1);
  expect(r4.some((m) => m.title === "Tiny Candidate")).toBe(true);
});
