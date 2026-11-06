import { computeLockDigest } from "@penumbra/core/evals/holdout";
import { type ReceiptClaimBody, ReceiptClaimSchema } from "@penumbra/core/evals/manifest";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type { BenchTask } from "../bench-prompts.js";

import { gradeSchemaTask } from "../bench-grade.js";
import { DEFAULT_CORPUS_ROOT, lintCorpus } from "./corpus.js";
import { type GraderScratch, openGraderScratch } from "./grader/scratch.js";
import { type VerifyContext, verifyReceipt } from "./grader/verify.js";
import { buildReplayEpisodes } from "./replay.js";

// bench-adapter.ts does not exist yet: the P14 bench-adapter surface is
// declared structurally below and the module is loaded dynamically so every
// case fails on the `expect(adapterMod).not.toBeNull()` assertion at RED time
// instead of on a missing import (the same pattern replay.test.ts uses).
interface AdaptedCommits {
  final_commit_attribution: string;
  attribution_basis: string;
  autocommit_flag: boolean | null;
}

interface AdaptedRecord {
  attempt_n: number;
  dispatch_ok: boolean;
  check_passed: boolean;
  passed: boolean;
  commits: AdaptedCommits;
  assistance: { kind: string; attempt_n: number; ref: string | null }[];
  receipts: ReceiptClaimBody[];
}

interface AdapterModule {
  adaptRoundRecord(raw: unknown): AdaptedRecord;
  schemaCheckClaim(
    v: { verdict: "PASS" | "PARTIAL" | "FAIL"; detail: string },
    sha: string | null,
  ): ReceiptClaimBody;
  judgeClaim(r: { verdict: string; model?: string }, sha: string | null): ReceiptClaimBody;
}

const ADAPTER_URL = new URL("./bench-adapter.ts", import.meta.url).href;

let adapterMod: AdapterModule | null = null;

beforeAll(async () => {
  adapterMod = (await import(ADAPTER_URL).catch(() => null)) as AdapterModule | null;
});

function adapter(): AdapterModule {
  expect(adapterMod).not.toBeNull();
  return adapterMod!;
}

const scratches: GraderScratch[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.close();
  }
});

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, out);
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

function stubVerifyCtx(): VerifyContext {
  return {
    lock: { schema_version: 1, entries: [], digest: computeLockDigest([]) },
    publicFixtures: [],
    store: { readEntry: () => Promise.reject(new Error("store must not be read")) },
    scratch: { buildBase: () => Promise.reject(new Error("scratch must not build")) },
    controls: { ensure: () => Promise.reject(new Error("controls must not run")) },
    allowlist: { builds: [] },
    grade: () => Promise.reject(new Error("grade must not run")),
    buildId: "0".repeat(64),
  };
}

test("adaptRoundRecord turns an autocommitted round record into receipts without agent identity", async () => {
  const mod = adapter();
  const goldenUrl = new URL(
    "../../../../plugin/workflows/penumbra-fix-until-green/round-record.golden.json",
    import.meta.url,
  );
  const text = await readFile(goldenUrl, "utf8").catch(() => null);
  expect(text).not.toBeNull();
  const golden = JSON.parse(text!) as { round: number; autocommit_sha?: string };

  const out = mod.adaptRoundRecord(JSON.parse(text!));
  const autocommit = out.assistance.find((a) => a.kind === "recovery_autocommit");
  expect(autocommit).toBeDefined();
  expect(autocommit).toMatchObject({
    kind: "recovery_autocommit",
    attempt_n: golden.round,
    ref: golden.autocommit_sha,
  });
  expect(out.commits).toEqual({
    final_commit_attribution: "recovery",
    attribution_basis: "dispatch_end_autocommitted",
    autocommit_flag: true,
  });
  expect(collectKeys(out)).not.toContain("agent");
  expect(out.receipts.filter((receipt) => receipt.kind === "hidden_assertion")).toHaveLength(0);

  const mutated = JSON.parse(text!) as Record<string, unknown>;
  delete mutated["autocommitted"];
  const bare = mod.adaptRoundRecord(mutated);
  expect(bare.assistance).toEqual([]);
  expect(bare.commits).toEqual({
    final_commit_attribution: "unknown",
    attribution_basis: "none",
    autocommit_flag: null,
  });

  const source = await readFile(new URL("./bench-adapter.ts", import.meta.url), "utf8").catch(
    () => null,
  );
  expect(source).not.toBeNull();
  expect(source!).not.toMatch(/\bagent\b/);
  expect(source!).not.toContain("plugin/");
});

test("schema and judge claims are receipt-shaped but never verify as hidden assertions", async () => {
  const mod = adapter();
  const task: BenchTask = {
    id: "T9",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
  };
  const graded = gradeSchemaTask(task, "[]");
  const sha = "c".repeat(40);

  const schemaClaim = mod.schemaCheckClaim(graded, sha);
  expect(schemaClaim.kind).toBe("schema_check");
  expect(ReceiptClaimSchema.safeParse(schemaClaim).success).toBe(true);

  const judgeClaim = mod.judgeClaim({ verdict: "PASS", model: "m" }, sha);
  expect(judgeClaim.kind).toBe("llm_judge");
  expect(ReceiptClaimSchema.safeParse(judgeClaim).success).toBe(true);

  const scratch = await openGraderScratch({ sourceRepo: null });
  scratches.push(scratch);
  const fixtures = await lintCorpus(DEFAULT_CORPUS_ROOT, { scratch });
  const entry = fixtures.find((fixture) => fixture.dir === "synthetic/syn-contract-validator");
  expect(entry).not.toBeUndefined();
  const episodes = await buildReplayEpisodes([entry!], { scratch });
  expect(episodes.length).toBeGreaterThan(0);
  const episode = episodes[0]!;
  const ctx = stubVerifyCtx();
  for (const claim of [schemaClaim, judgeClaim]) {
    episode.receipts = [claim];
    const res = await verifyReceipt(claim, episode, ctx);
    expect(res).toEqual({ status: "rejected", reason: "not_independent_kind" });
  }
}, 120_000);
