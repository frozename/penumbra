import type { Logger } from "@penumbra/core";

import { describe, expect, test } from "bun:test";

import type { PenumbraClient } from "../../src/penumbra-client.js";

import { RecallContextConfigSchema } from "../../src/config/types.js";
import { RecallEnricher } from "../../src/worker/recall-enricher.js";

type RecallClient = Pick<PenumbraClient, "recall" | "corpusQuery">;
type RecallBody = Parameters<RecallClient["recall"]>[0];
type RecallResponse = Awaited<ReturnType<RecallClient["recall"]>>;
type CorpusBody = Parameters<RecallClient["corpusQuery"]>[0];
type CorpusResponse = Awaited<ReturnType<RecallClient["corpusQuery"]>>;

type RecallBehavior = RecallResponse | Error | ((body: RecallBody) => RecallResponse);
type CorpusBehavior = CorpusResponse | Error | ((body: CorpusBody) => CorpusResponse);

// Pino's `Logger` is a complex class with many overloads; tests only need a
// silent stub that satisfies the surface used by RecallEnricher (warn).
function silentLog(): Logger {
  const noop = (): void => {
    /* noop */
  };
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

interface FakeClientHandle {
  client: RecallClient;
  calls: RecallBody[];
  recallCalls: RecallBody[];
  corpusCalls: CorpusBody[];
}

function fakeClient(
  opts: { recall?: RecallBehavior; corpusQuery?: CorpusBehavior } = {},
): FakeClientHandle {
  const recallCalls: RecallBody[] = [];
  const corpusCalls: CorpusBody[] = [];
  const recallBehavior: RecallBehavior = opts.recall ?? { results: [] };
  const corpusBehavior: CorpusBehavior = opts.corpusQuery ?? { hits: [] };
  const client: RecallClient = {
    recall: (body: RecallBody): Promise<RecallResponse> => {
      recallCalls.push(body);
      if (recallBehavior instanceof Error) return Promise.reject(recallBehavior);
      if (typeof recallBehavior === "function") return Promise.resolve(recallBehavior(body));
      return Promise.resolve(recallBehavior);
    },
    corpusQuery: (body: CorpusBody): Promise<CorpusResponse> => {
      corpusCalls.push(body);
      if (corpusBehavior instanceof Error) return Promise.reject(corpusBehavior);
      if (typeof corpusBehavior === "function") return Promise.resolve(corpusBehavior(body));
      return Promise.resolve(corpusBehavior);
    },
  };
  return { client, calls: recallCalls, recallCalls, corpusCalls };
}

describe("RecallEnricher", () => {
  const baseConfig = RecallContextConfigSchema.parse({
    enabled: true,
    k: 3,
    scope: "project",
    max_chars_per_result: 200,
  });

  test("returns message unchanged when config is disabled", async () => {
    const cfg = RecallContextConfigSchema.parse({ enabled: false });
    const { client, calls } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: "task", config: cfg, projectId: "p" });
    expect(out).toBe("task");
    expect(calls).toHaveLength(0);
  });

  test("returns message unchanged when recall returns no results", async () => {
    const { client } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: "task", config: baseConfig, projectId: "p" });
    expect(out).toBe("task");
  });

  test("soft-fails when recall throws — original message returned", async () => {
    const { client } = fakeClient({ recall: new Error("daemon unreachable") });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: "task", config: baseConfig, projectId: "p" });
    expect(out).toBe("task");
  });

  test("soft-fails on timeout — original message returned", async () => {
    const client: RecallClient = {
      recall: (): Promise<RecallResponse> =>
        new Promise(() => {
          /* never resolves */
        }),
      corpusQuery: (): Promise<CorpusResponse> =>
        new Promise(() => {
          /* never resolves */
        }),
    };
    const enricher = new RecallEnricher({ client, log: silentLog(), timeoutMs: 10 });
    const out = await enricher.enrich({ message: "task", config: baseConfig, projectId: "p" });
    expect(out).toBe("task");
  });

  test("prepends a recent-relevant-context block when results exist", async () => {
    const { client, calls } = fakeClient({
      recall: {
        results: [
          {
            id: "r1",
            tier: "t1",
            score: 0.92,
            title: null,
            body: "Last time we hit this we tried approach X and it worked.",
            project_id: "proj-a",
            source_session_ids: ["s1"],
            created_at: "2026-05-01T00:00:00Z",
            ts: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({
      message: "fix the failing test in foo.test.ts",
      config: baseConfig,
      projectId: "proj-a",
    });
    expect(out).toContain("<recent-relevant-context>");
    expect(out).toContain("approach X");
    expect(out).toContain("tier=t1");
    expect(out).toEndWith("fix the failing test in foo.test.ts");
    expect(calls[0]?.project_id).toBe("proj-a");
    expect(calls[0]?.limit).toBe(3);
  });

  test("truncates result bodies to max_chars_per_result", async () => {
    const longBody = "x".repeat(500);
    const { client } = fakeClient({
      recall: {
        results: [
          {
            id: "r1",
            tier: "t1",
            score: 0.5,
            title: null,
            body: longBody,
            project_id: null,
            source_session_ids: [],
            created_at: "2026-05-01T00:00:00Z",
            ts: "2026-05-01T00:00:00Z",
          },
        ],
      },
    });
    const cfg = RecallContextConfigSchema.parse({
      enabled: true,
      k: 1,
      scope: "global",
      max_chars_per_result: 50,
    });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: "go", config: cfg, projectId: null });
    // 50 chars + ellipsis, not the full 500
    expect(out).toContain("x".repeat(50) + "…");
    expect(out).not.toContain("x".repeat(51));
  });

  test("uses scope=project filter when projectId is set", async () => {
    const { client, calls } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    await enricher.enrich({ message: "go", config: baseConfig, projectId: "proj-x" });
    expect(calls[0]?.project_id).toBe("proj-x");
  });

  test("falls back to global scope when projectId is null even if config requests project", async () => {
    const { client, calls } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    await enricher.enrich({ message: "go", config: baseConfig, projectId: null });
    expect(calls[0]?.project_id).toBeNull();
  });

  test("uses global scope when explicitly configured", async () => {
    const cfg = RecallContextConfigSchema.parse({ enabled: true, scope: "global" });
    const { client, calls } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    await enricher.enrich({ message: "go", config: cfg, projectId: "proj-x" });
    expect(calls[0]?.project_id).toBeNull();
  });

  test("truncates query to first 500 chars of message", async () => {
    const { client, calls } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const longMessage = "a".repeat(2000);
    await enricher.enrich({ message: longMessage, config: baseConfig, projectId: "p" });
    expect(calls[0]?.query.length).toBe(500);
  });

  test("returns message unchanged when message trims to empty", async () => {
    const { client, calls } = fakeClient({ recall: { results: [] } });
    const enricher = new RecallEnricher({ client, log: silentLog() });
    const out = await enricher.enrich({ message: "   ", config: baseConfig, projectId: "p" });
    expect(out).toBe("   ");
    expect(calls).toHaveLength(0);
  });

  describe("corpus scope", () => {
    const corpusConfig = RecallContextConfigSchema.parse({
      enabled: true,
      k: 5,
      scope: "corpus:acp-work",
      max_chars_per_result: 200,
    });

    test("routes to corpusQuery (not recall) and injects hits", async () => {
      const { client, recallCalls, corpusCalls } = fakeClient({
        corpusQuery: {
          hits: [
            {
              id: "h1",
              ts: "2026-04-01T00:00:00Z",
              obs_type: "change",
              title: "fix watchdog",
              body: "Bumped watchdog to 300s when fs requests arrive.",
              score: 0.81,
              project_id: "penumbra",
            },
          ],
        },
      });
      const enricher = new RecallEnricher({ client, log: silentLog() });
      const out = await enricher.enrich({
        message: "continue ACP work",
        config: corpusConfig,
        projectId: "penumbra",
      });
      expect(recallCalls).toHaveLength(0);
      expect(corpusCalls).toHaveLength(1);
      expect(corpusCalls[0]?.name).toBe("acp-work");
      expect(corpusCalls[0]?.limit).toBe(5);
      expect(corpusCalls[0]?.query).toBe("continue ACP work");
      expect(out).toContain("<recent-relevant-context>");
      expect(out).toContain("Bumped watchdog");
      expect(out).toContain("tier=corpus");
      expect(out).toEndWith("continue ACP work");
    });

    test("returns message unchanged when corpus has no hits", async () => {
      const { client, recallCalls, corpusCalls } = fakeClient({
        corpusQuery: { hits: [] },
      });
      const enricher = new RecallEnricher({ client, log: silentLog() });
      const out = await enricher.enrich({
        message: "task",
        config: corpusConfig,
        projectId: null,
      });
      expect(out).toBe("task");
      expect(recallCalls).toHaveLength(0);
      expect(corpusCalls).toHaveLength(1);
    });

    test("soft-fails when corpusQuery throws — original message returned", async () => {
      const { client, recallCalls } = fakeClient({
        corpusQuery: new Error("unknown corpus"),
      });
      const enricher = new RecallEnricher({ client, log: silentLog() });
      const out = await enricher.enrich({
        message: "task",
        config: corpusConfig,
        projectId: null,
      });
      expect(out).toBe("task");
      expect(recallCalls).toHaveLength(0);
    });
  });
});
