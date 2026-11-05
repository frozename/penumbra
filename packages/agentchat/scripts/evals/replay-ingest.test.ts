import { taskDigest } from "@penumbra/core/evals/canonical";
import {
  type FixturePublic,
  FixturePublicSchema,
  HoldoutBundleSchema,
} from "@penumbra/core/evals/fixture";
import { classifyHelper, parseRetryOf, stripRetryStamp } from "@penumbra/core/evals/lineage";
import {
  type Attempt,
  AttemptHistorySchema,
  AttemptSchema,
  ReceiptClaimSchema,
} from "@penumbra/core/evals/manifest";
import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DependencyProvider } from "./grader/deps.js";

import { CorpusLintError, DEFAULT_CORPUS_ROOT, lintCorpus } from "./corpus.js";
import { ControlCache } from "./grader/control.js";
import { type GraderScratch, openGraderScratch } from "./grader/scratch.js";

// @penumbra/core/evals/ingest does not exist yet: the P12 rows-ingestion
// surface is declared structurally below and the module is loaded dynamically
// so every ingest case fails on the `expect(ingestMod).not.toBeNull()`
// assertion at RED time instead of on a missing import.
interface IngestEpisode {
  task_digest: string | null;
  final_sha: string | null;
  lineage: {
    root_handoff_id: string | null;
    handoff_ids: string[];
  };
  attempt_history: {
    status: string;
    reason: string | null;
    count: number | null;
    count_basis: string;
  };
  attempts: Attempt[];
  assistance: { kind: string; attempt_n: number; ref: string | null }[];
  receipts: Record<string, unknown>[];
  first_attempt: string;
  effective_models: Record<string, unknown>[];
  tool_failures: { attempt_n: number; count: number }[];
}

interface IngestResult {
  episodes: IngestEpisode[];
  report: {
    excluded: { helper_check_verifier: number; helper_rubric_grader: number };
    [key: string]: unknown;
  };
}

interface IngestModule {
  IngestRowsSchema: { parse(value: unknown): unknown };
  ingestRows(rows: unknown, opts: { now: number; retentionDays: number }): IngestResult;
}

const SPEC = "@penumbra/core/evals/ingest";

let ingestMod: IngestModule | null = null;

beforeAll(async () => {
  ingestMod = (await import(SPEC).catch(() => null)) as IngestModule | null;
});

function ingest(): IngestModule {
  expect(ingestMod).not.toBeNull();
  return ingestMod!;
}

const NOW = Date.parse("2026-06-15T00:00:00.000Z");
const RETENTION_DAYS = 30;

interface HandoffLite {
  handoff_id: string;
  message: string;
  parent_handoff_id: string | null;
  triggered_by_event_id: string | null;
  branch_base: string | null;
  branch_name: string | null;
}

interface EventLite {
  handoff_id: string;
  [key: string]: unknown;
}

interface RowsFile {
  handoffs: HandoffLite[];
  events: EventLite[];
  retry_events?: unknown[];
  [key: string]: unknown;
}

const scratches: GraderScratch[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function mkScratch(): Promise<GraderScratch> {
  const scratch = await openGraderScratch({ sourceRepo: null });
  scratches.push(scratch);
  return scratch;
}

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function copyCorpus(): string {
  const dst = mkTmp("penumbra-corpus-");
  cpSync(DEFAULT_CORPUS_ROOT, dst, { recursive: true });
  return dst;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function corpusFixtureDir(dir: string): string {
  return join(DEFAULT_CORPUS_ROOT, "synthetic", dir);
}

function readRowsFile(dir: string, file = "rows.json"): RowsFile {
  const path = join(corpusFixtureDir(dir), file);
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as RowsFile;
}

function ingestRowsValue(rows: unknown): IngestResult {
  const m = ingest();
  return m.ingestRows(m.IngestRowsSchema.parse(rows), {
    now: NOW,
    retentionDays: RETENTION_DAYS,
  });
}

function ingestFixtureRows(dir: string, file = "rows.json"): IngestResult {
  return ingestRowsValue(readRowsFile(dir, file));
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0]!;
}

function expectWellFormed(episode: IngestEpisode): void {
  for (const attempt of episode.attempts) {
    AttemptSchema.parse(attempt);
  }
  AttemptHistorySchema.parse(episode.attempt_history);
}

interface FixRoundRows {
  a: HandoffLite;
  b: HandoffLite;
  c: HandoffLite;
  v: HandoffLite;
  g: HandoffLite;
}

function identifyFixRounds(handoffs: readonly HandoffLite[]): FixRoundRows {
  const v = handoffs.find((h) => classifyHelper(h) === "helper_check_verifier");
  const g = handoffs.find((h) => classifyHelper(h) === "helper_rubric_grader");
  expect(v).not.toBeUndefined();
  expect(g).not.toBeUndefined();
  const tasks = handoffs.filter((h) => classifyHelper(h) === null);
  expect(tasks).toHaveLength(3);
  const byBranchName = new Map<string, HandoffLite>();
  for (const task of tasks) {
    if (task.branch_name !== null) {
      byBranchName.set(task.branch_name, task);
    }
  }
  const successors = tasks.filter((task) => {
    const base = task.branch_base;
    if (base === null || parseRetryOf(task.message) !== null) {
      return false;
    }
    const producer = byBranchName.get(base);
    return producer !== undefined && producer !== task;
  });
  expect(successors).toHaveLength(1);
  const b = successors[0]!;
  const a = byBranchName.get(b.branch_base!)!;
  const c = tasks.find(
    (task) => task !== a && task !== b && parseRetryOf(task.message) === b.handoff_id,
  );
  expect(c).not.toBeUndefined();
  return { a, b, c: c!, v: v!, g: g! };
}

test("ingestRows syn-model-identity yields an unattested effective model", () => {
  const result = ingestFixtureRows("syn-model-identity");
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.attempts).toHaveLength(1);
  expect(episode.effective_models).toEqual([
    {
      attempt_n: 1,
      value: null,
      provenance: "unattested",
      missing_reason: "acp.model_unavailable",
    },
  ]);
  expect(episode.first_attempt).toBe("eligible");
});

test("ingestRows syn-lane-gate-evidence keeps the lane gate receipt non-verifying", () => {
  const result = ingestFixtureRows("syn-lane-gate-evidence");
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.receipts).toHaveLength(1);
  const claim = episode.receipts[0]!;
  expect(claim).toMatchObject({
    kind: "lane_gate",
    sha: null,
    claimed_verdict: "pass",
    producer: "lane_ledger",
  });
  ReceiptClaimSchema.parse(claim);
  expect(episode.receipts.some((receipt) => receipt.kind === "hidden_assertion")).toBe(false);
});

test("ingestRows syn-missed-commit attributes the final commit to recovery", () => {
  const result = ingestFixtureRows("syn-missed-commit");
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.attempts).toHaveLength(1);
  const attempt = episode.attempts[0]!;
  expect(attempt.commits).toEqual({
    final_commit_attribution: "recovery",
    attribution_basis: "dispatch_end_autocommitted",
    autocommit_flag: true,
  });
  expect(episode.final_sha).toBe(attempt.head_sha);
  expect(episode.final_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(episode.first_attempt).toBe("eligible");
});

test("ingestRows syn-reclaim-recovery scopes contract flags per attempt", () => {
  const result = ingestFixtureRows("syn-reclaim-recovery");
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.attempts).toHaveLength(2);
  expect(episode.attempts.map((attempt) => attempt.n)).toEqual([1, 2]);
  expect(new Set(episode.attempts.map((attempt) => attempt.handoff_id)).size).toBe(1);
  expect(episode.attempt_history).toEqual({
    status: "complete",
    reason: null,
    count: 2,
    count_basis: "claim_events",
  });
  expect(episode.attempts[0]!.contract_flags).toEqual({
    scope: "attempt",
    source: "attempt_dispatch_end",
    base_not_ancestor: true,
    identity_mismatch: false,
  });
  expect(episode.attempts[1]!.contract_flags).toEqual({
    scope: "attempt",
    source: "attempt_dispatch_end",
    base_not_ancestor: false,
    identity_mismatch: false,
  });
  expect(episode.attempts[1]!.commits).toEqual({
    final_commit_attribution: "recovery",
    attribution_basis: "dispatch_end_autocommitted",
    autocommit_flag: true,
  });
  expect(episode.first_attempt).toBe("ineligible");
});

test("ingestRows syn-tool-failure counts the tool failure on attempt 2", () => {
  const result = ingestFixtureRows("syn-tool-failure");
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.attempts).toHaveLength(2);
  expect(episode.tool_failures).toEqual([
    { attempt_n: 1, count: 0 },
    { attempt_n: 2, count: 1 },
  ]);
});

test("ingestRows rows-pruned reports partial claim history with only the last attempt", () => {
  const result = ingestFixtureRows("syn-reclaim-recovery", "rows-pruned.json");
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.attempt_history).toEqual({
    status: "partial",
    reason: "claims_pruned",
    count: 2,
    count_basis: "handoff_counter",
  });
  expect(episode.attempts).toHaveLength(1);
  expect(episode.attempts[0]!.n).toBe(2);
  expect(episode.first_attempt).toBe("unknown");
});

test("ingestRows syn-fix-rounds builds one episode across fix round and stamped retry", () => {
  const rows = readRowsFile("syn-fix-rounds");
  const { a, b, c, v, g } = identifyFixRounds(rows.handoffs);
  const result = ingestRowsValue(rows);
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect([...episode.lineage.handoff_ids].sort()).toEqual(
    [a.handoff_id, b.handoff_id, c.handoff_id].sort(),
  );
  expect(episode.lineage.root_handoff_id).toBe(a.handoff_id);
  expect(episode.assistance.map((entry) => entry.kind)).toEqual(["fix_round", "retry_child"]);
  expect(episode.attempts.map((attempt) => attempt.n)).toEqual([1, 2, 3]);
  expect(episode.attempts.map((attempt) => attempt.handoff_id)).toEqual([
    a.handoff_id,
    b.handoff_id,
    c.handoff_id,
  ]);
  expect(episode.attempt_history).toEqual({
    status: "complete",
    reason: null,
    count: 3,
    count_basis: "claim_events",
  });
  expect(episode.first_attempt).toBe("ineligible");
  expect(result.report.excluded).toEqual({
    helper_check_verifier: 1,
    helper_rubric_grader: 1,
  });
  for (const helperId of [v.handoff_id, g.handoff_id]) {
    expect(episode.lineage.handoff_ids).not.toContain(helperId);
    expect(episode.attempts.some((attempt) => attempt.handoff_id === helperId)).toBe(false);
  }
  expect(episode.task_digest).toBe(taskDigest(stripRetryStamp(a.message)));
});

test("ingestRows keeps the stamped retry join when dispatch events are absent", () => {
  const rows = readRowsFile("syn-fix-rounds");
  const { a, b, c } = identifyFixRounds(rows.handoffs);
  const cRow = rows.handoffs.find((h) => h.handoff_id === c.handoff_id);
  expect(cRow).not.toBeUndefined();
  expect(cRow!.parent_handoff_id).toBeNull();
  expect(cRow!.triggered_by_event_id).toBeNull();
  expect(rows.retry_events ?? []).toHaveLength(0);

  const result = ingestRowsValue({ ...rows, events: [] });
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.attempt_history).toMatchObject({
    status: "unavailable",
    reason: "events_absent",
  });
  expect(episode.attempts).toEqual([]);
  expect([...episode.lineage.handoff_ids].sort()).toEqual(
    [a.handoff_id, b.handoff_id, c.handoff_id].sort(),
  );
  expect(
    episode.assistance.some((entry) => entry.kind === "retry_child" && entry.ref === b.handoff_id),
  ).toBe(true);
  expect(episode.first_attempt).toBe("unknown");
});

for (const dir of ["syn-reclaim-recovery", "syn-fixture-contract"]) {
  test(`control self-qualifies corpus fixture ${dir}`, async () => {
    const scratch = await mkScratch();
    const fixtureDir = corpusFixtureDir(dir);
    expect(existsSync(join(fixtureDir, "bundle.json"))).toBe(true);
    expect(existsSync(join(fixtureDir, "repo.files.json"))).toBe(true);
    const repoFiles = readJson(join(fixtureDir, "repo.files.json")) as Record<string, string>;
    const bundle = HoldoutBundleSchema.parse({
      ...readJson(join(fixtureDir, "bundle.json")),
      repo_files: repoFiles,
    });
    const cacheDir = mkTmp("penumbra-corpus-deps-");
    mkdirSync(join(cacheDir, "node_modules"), { recursive: true });
    const deps: DependencyProvider = {
      ensure: () => Promise.resolve({ ok: true, cacheDir }),
    };
    const controls = new ControlCache({
      scratch,
      sandbox: "none",
      deps,
      buildId: "corpus-test",
      timeoutMs: 20_000,
    });
    const outcome = await controls.ensure(
      { family_id: bundle.family_id, variant_id: bundle.variant_id },
      bundle,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.control.verdict).toBe("pass");
    expect(outcome.self_qualification).toEqual({ ok: true });
  }, 120_000);
}

interface PinnedFamily {
  dir: string;
  failureType: FixturePublic["failure_type"];
  reconstructs: FixturePublic["reconstructs"];
  task: string;
}

const PINNED_FAMILIES: readonly PinnedFamily[] = [
  {
    dir: "syn-reclaim-recovery",
    failureType: "long_context_recovery",
    reconstructs: { kind: "issue", number: 322 },
    task: "Implement claim recovery described by test/recovery.test.ts.",
  },
  {
    dir: "syn-tool-failure",
    failureType: null,
    reconstructs: null,
    task: "Implement tool failure accounting described by test/tools.test.ts.",
  },
  {
    dir: "syn-fixture-contract",
    failureType: "invalid_fixture_contract",
    reconstructs: { kind: "operator_bundle", id: "kapitsa-fixture-contract" },
    task: "Implement the fixture contract checker described by test/contract.test.ts.",
  },
  {
    dir: "syn-fix-rounds",
    failureType: null,
    reconstructs: null,
    task: "Implement fix round tracking described by test/rounds.test.ts.",
  },
];

const NEW_FAMILY_DIRS = PINNED_FAMILIES.map((entry) => entry.dir);

for (const entry of PINNED_FAMILIES) {
  test(`corpus fixture ${entry.dir} parses and matches the pinned P12 contract`, () => {
    const path = join(corpusFixtureDir(entry.dir), "fixture.json");
    expect(existsSync(path)).toBe(true);
    const parsed = FixturePublicSchema.safeParse(readJson(path));
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`fixture ${entry.dir} failed FixturePublicSchema`);
    }
    const fixture = parsed.data;
    expect(fixture.family_id).toBe(`fam-${entry.dir}`);
    expect(fixture.variant_id).toBe("v1");
    expect(fixture.root).toEqual({
      kind: "synthetic",
      id: entry.dir.slice("syn-".length),
    });
    expect(fixture.split).toBe("dev");
    expect(fixture.synthetic).toBe(true);
    expect(fixture.expect_blocked).toBe(false);
    expect(fixture.source_root_handoff_digests).toEqual([]);
    expect(fixture.task_digest).toBe(taskDigest(entry.task));
    expect(fixture.failure_type).toBe(entry.failureType);
    expect(fixture.reconstructs).toEqual(entry.reconstructs);
  });
}

test("lintCorpus resolves the real corpus including the new P12 families", async () => {
  const scratch = await mkScratch();
  const fixtures = await lintCorpus(DEFAULT_CORPUS_ROOT, { scratch });
  const ids = fixtures.map((fixture) => fixture.fixture.family_id);
  for (const dir of NEW_FAMILY_DIRS) {
    expect(ids).toContain(`fam-${dir}`);
  }
});

test("lintCorpus rejects malformed rows files but keeps unexpected_file for other names", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const dir = join(tmp, "synthetic", "syn-contract-validator");
  expect(existsSync(dir)).toBe(true);

  const rowsPath = join(dir, "rows-pruned.json");
  writeJsonFile(rowsPath, {});
  let err = await catchErr(() => lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(CorpusLintError);
  expect(errMsg(err)).toContain("invalid_rows");

  rmSync(rowsPath);
  writeJsonFile(join(dir, "notes.json"), {});
  err = await catchErr(() => lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(CorpusLintError);
  expect(errMsg(err)).toContain("unexpected_file");
});

test("ingestRows is deterministic under handoff and event order", () => {
  const rows = readRowsFile("syn-fix-rounds");
  const m = ingest();
  const opts = { now: NOW, retentionDays: RETENTION_DAYS };
  const first = m.ingestRows(m.IngestRowsSchema.parse(rows), opts);
  const second = m.ingestRows(m.IngestRowsSchema.parse(rows), opts);
  expect(second).toEqual(first);
  const reversed = {
    ...rows,
    handoffs: [...rows.handoffs].reverse(),
    events: [...rows.events].reverse(),
  };
  const third = m.ingestRows(m.IngestRowsSchema.parse(reversed), opts);
  expect(third).toEqual(first);
});

test("ingestRows marks the first attempt ineligible when only retry assistance remains", () => {
  const rows = readRowsFile("syn-fix-rounds");
  const { b, c } = identifyFixRounds(rows.handoffs);
  const cEvents = rows.events.filter((event) => event.handoff_id === c.handoff_id);
  expect(cEvents.length).toBeGreaterThan(0);
  const cOnly = {
    ...rows,
    handoffs: [c],
    events: cEvents,
    retry_events: [],
  };
  const result = ingestRowsValue(cOnly);
  const episode = only(result.episodes);
  expectWellFormed(episode);
  expect(episode.lineage.root_handoff_id).toBe(c.handoff_id);
  expect(episode.lineage.handoff_ids).toEqual([c.handoff_id]);
  expect(episode.attempt_history).toEqual({
    status: "complete",
    reason: null,
    count: 1,
    count_basis: "claim_events",
  });
  expect(episode.attempts).toHaveLength(1);
  expect(episode.assistance).toEqual([{ kind: "retry_child", attempt_n: 1, ref: b.handoff_id }]);
  expect(episode.first_attempt).toBe("ineligible");
});
