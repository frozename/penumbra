import {
  familyIdForRoot,
  type HoldoutLock,
  type HoldoutLockEntry,
  type RootRef,
} from "@penumbra/core/evals/fixture";
import {
  assertNoPublicFix,
  computeLockDigest,
  HoldoutLockError,
  PublicFixError,
  type PublicFixEvidence,
} from "@penumbra/core/evals/holdout";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  defaultRunCommand,
  type RunCommand,
  type RunCommandOptions,
  type RunCommandResult,
} from "./grader/materialize.js";

// audit-holdout-roots.ts does not exist yet: the API is declared structurally
// below and the module is loaded dynamically so every case fails on the
// `expect(mod).not.toBeNull()` assertion at RED time instead of on a missing
// import (the same pattern holdout-store.test.ts uses for holdout-store.ts).
type AuditCollisionVia = "root" | "reconstructs" | "unparseable";

interface AuditCollision {
  commit: string;
  path: string;
  fixture_family_id: string;
  fixture_variant_id: string;
  lock_family_id: string;
  lock_variant_id: string;
  via: AuditCollisionVia;
}

interface AuditReservation {
  ok: boolean;
  collisions: AuditCollision[];
}

interface AuditResult {
  head_sha: string;
  evidence: PublicFixEvidence;
  reservation: AuditReservation;
}

interface AuditHoldoutRootsOpts {
  repoRoot: string;
  lock: unknown;
  readGoodPatch: (entry: HoldoutLockEntry) => Promise<string>;
  run?: RunCommand;
  ghRepo?: string;
  fixturesPrefix?: string;
}

interface AuditHoldoutRootsApi {
  auditHoldoutRoots(opts: AuditHoldoutRootsOpts): Promise<AuditResult>;
  HoldoutAuditError: new (...args: never[]) => Error;
}

const AUDIT_MODULE_URL = new URL("./audit-holdout-roots.ts", import.meta.url).href;

async function loadAudit(): Promise<AuditHoldoutRootsApi> {
  const mod = (await import(AUDIT_MODULE_URL).catch(() => null)) as AuditHoldoutRootsApi | null;
  expect(mod).not.toBeNull();
  return mod!;
}

// --- git fixtures ---------------------------------------------------------------

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GIT_ENV: NodeJS.ProcessEnv = ((): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "audit-test",
    GIT_AUTHOR_EMAIL: "audit@test.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
    GIT_COMMITTER_NAME: "audit-test",
    GIT_COMMITTER_EMAIL: "audit@test.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
  };
})();

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  expect(res.status).toBe(0);
  return res.stdout;
}

function writeRepoFile(repoRoot: string, rel: string, content: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function mkRepo(): string {
  const dir = mkTmp("penumbra-audit-repo-");
  git(dir, ["init", "-q"]);
  return dir;
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function headSha(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function onSideBranch<T>(repo: string, name: string, fn: () => T): T {
  git(repo, ["checkout", "-qb", name]);
  try {
    return fn();
  } finally {
    git(repo, ["checkout", "-q", "-"]);
  }
}

interface PatchEdit {
  path: string;
  before: string;
  after: string;
}

function mkGoodPatch(edits: PatchEdit[]): string {
  const dir = mkTmp("penumbra-audit-scratch-");
  git(dir, ["init", "-q"]);
  for (const edit of edits) {
    writeRepoFile(dir, edit.path, edit.before);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  for (const edit of edits) {
    writeRepoFile(dir, edit.path, edit.after);
  }
  git(dir, ["add", "-A"]);
  return git(dir, ["diff", "--cached"]);
}

let cachedCleanPatch: string | null = null;

function cleanPatch(): string {
  cachedCleanPatch ??= mkGoodPatch([
    {
      path: "src/clean-audit.ts",
      before: "export const cleanA = 1;\nexport const cleanB = 2;\n",
      after: "export const cleanA = 1;\nexport const cleanB = 3;\n// done\n",
    },
  ]);
  return cachedCleanPatch;
}

// --- lock fixtures ---------------------------------------------------------------

const OP_ROOT: RootRef = { kind: "operator_bundle", id: "canary" };
const ISSUE_ROOT: RootRef = { kind: "issue", number: 4242 };
const SYN_ROOT: RootRef = { kind: "synthetic", id: "audit-probe" };
const GH_REPO = "acme/widgets";
const FIXTURES_PREFIX = "packages/agentchat/test/fixtures/evals/";

function mkEntry(root: RootRef, variantId: string, synthetic: boolean): HoldoutLockEntry {
  return {
    family_id: familyIdForRoot(root),
    variant_id: variantId,
    root,
    failure_type: synthetic ? null : "missed_commit",
    synthetic,
    expect_blocked: false,
    base_sha: "a".repeat(40),
    task_digest: "b".repeat(64),
    source_root_handoff_digests: [],
    content_digest: "c".repeat(64),
    assertion_set_digest: "d".repeat(64),
  };
}

function mkLock(entries: HoldoutLockEntry[]): HoldoutLock {
  return { schema_version: 1, entries, digest: computeLockDigest(entries) };
}

function mkFixturePublic(args: {
  family_id: string;
  variant_id: string;
  root: RootRef;
  reconstructs?: RootRef | null;
  synthetic?: boolean;
  failure_type: string | null;
}): Record<string, unknown> {
  const synthetic = args.synthetic ?? args.root.kind === "synthetic";
  return {
    schema_version: 1,
    family_id: args.family_id,
    variant_id: args.variant_id,
    root: args.root,
    reconstructs: args.reconstructs ?? null,
    failure_type: args.failure_type,
    split: "holdout",
    synthetic,
    base_sha: "a".repeat(40),
    task_digest: "b".repeat(64),
    source_root_handoff_digests: [],
    expect_blocked: false,
    hidden_ref: { assertion_set_digest: "c".repeat(64) },
    content_digest: "d".repeat(64),
  };
}

function fixtureJson(args: Parameters<typeof mkFixturePublic>[0]): string {
  return `${JSON.stringify(mkFixturePublic(args), null, 2)}\n`;
}

function fixtureJsonRaw(args: {
  family_id: string;
  variant_id: string;
  root: unknown;
  reconstructs?: unknown;
  synthetic?: boolean;
  failure_type: string | null;
}): string {
  const synthetic =
    args.synthetic ??
    (typeof args.root === "object" && args.root !== null && "kind" in args.root
      ? (args.root as { kind: string }).kind === "synthetic"
      : false);
  return `${JSON.stringify(
    {
      schema_version: 1,
      family_id: args.family_id,
      variant_id: args.variant_id,
      root: args.root,
      reconstructs: args.reconstructs ?? null,
      failure_type: args.failure_type,
      split: "holdout",
      synthetic,
      base_sha: "a".repeat(40),
      task_digest: "b".repeat(64),
      source_root_handoff_digests: [],
      expect_blocked: false,
      hidden_ref: { assertion_set_digest: "c".repeat(64) },
      content_digest: "d".repeat(64),
    },
    null,
    2,
  )}\n`;
}

// --- runner ---------------------------------------------------------------------

interface RecordedCall {
  cmd: string;
  args: string[];
  opts?: RunCommandOptions;
}

interface RunnerHooks {
  gh?: (args: string[]) => RunCommandResult;
  fail?: (cmd: string, args: string[]) => RunCommandResult | null;
}

function ghJson(body: unknown, code = 0): RunCommandResult {
  return {
    code,
    stdout: Buffer.from(JSON.stringify(body), "utf8"),
    stderr: Buffer.alloc(0),
  };
}

function mkRunner(hooks: RunnerHooks = {}): { run: RunCommand; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: RunCommand = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const failed = hooks.fail?.(cmd, args) ?? null;
    if (failed !== null) {
      return Promise.resolve(failed);
    }
    if (cmd === "gh") {
      return Promise.resolve(hooks.gh?.(args) ?? ghJson({}));
    }
    return defaultRunCommand(cmd, args, opts);
  };
  return { run, calls };
}

function mkPatchReader(
  patch: string,
  seen?: HoldoutLockEntry[],
): (entry: HoldoutLockEntry) => Promise<string> {
  return (entry) => {
    seen?.push(entry);
    return Promise.resolve(patch);
  };
}

async function runAudit(
  api: AuditHoldoutRootsApi,
  opts: {
    repo: string;
    lock: HoldoutLock;
    patch: string;
    patchCalls?: HoldoutLockEntry[];
    hooks?: RunnerHooks;
    ghRepo?: string;
  },
): Promise<{ result: AuditResult; calls: RecordedCall[] }> {
  const { run, calls } = mkRunner(opts.hooks);
  const result = await api.auditHoldoutRoots({
    repoRoot: opts.repo,
    lock: opts.lock,
    readGoodPatch: mkPatchReader(opts.patch, opts.patchCalls),
    run,
    ghRepo: opts.ghRepo ?? GH_REPO,
  });
  return { result, calls };
}

async function expectAuditError(
  api: AuditHoldoutRootsApi,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(api.HoldoutAuditError);
  return caught;
}

function expectPublicFixError(fn: () => void): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PublicFixError);
}

function ghCalls(calls: RecordedCall[], verb: "issue" | "pr"): RecordedCall[] {
  return calls.filter(
    (call) => call.cmd === "gh" && call.args[0] === verb && call.args[1] === "view",
  );
}

// --- case 1: head_sha + synthetic skip --------------------------------------------

test("head_sha is rev-parse HEAD and synthetic entries get no evidence", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code one");
  writeRepoFile(repo, "src/y.ts", "export const y = 2;\n");
  commitAll(repo, "code two");
  const expectedHead = headSha(repo);

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false), mkEntry(SYN_ROOT, "v1", true)]);
  const patchCalls: HoldoutLockEntry[] = [];
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    patchCalls,
  });

  expect(result.head_sha).toBe(expectedHead);
  expect(Object.keys(result.evidence)).toEqual(["fam-op-canary/v1"]);
  expect(result.evidence["fam-op-canary/v1"]?.head_sha).toBe(expectedHead);
  expect(patchCalls).toHaveLength(1);
  expect(patchCalls[0]?.family_id).toBe("fam-op-canary");
});

test("synthetic-only lock reserves cleanly despite unparseable fixture history", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code");
  writeRepoFile(repo, `${FIXTURES_PREFIX}fam-bad-json/v1/fixture.json`, "{ not json");
  commitAll(repo, "add broken fixture");

  const lock = mkLock([mkEntry(SYN_ROOT, "v1", true)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation).toEqual({ ok: true, collisions: [] });
  expect(result.evidence).toEqual({});
});

// --- case 2: clean operator_bundle -------------------------------------------------

test("clean operator_bundle entry reports zero hits and passes assertNoPublicFix", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code one");
  writeRepoFile(repo, "src/y.ts", "export const y = 2;\n");
  commitAll(repo, "code two");

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const { result, calls } = await runAudit(api, { repo, lock, patch: cleanPatch() });
  const key = "fam-op-canary/v1";

  expect(result.head_sha).toBe(headSha(repo));
  expect(result.evidence[key]).toEqual({
    issue_closure: null,
    patch_id_hits: 0,
    added_line_hits: 0,
    head_sha: headSha(repo),
  });
  expect(calls.filter((call) => call.cmd === "gh")).toHaveLength(0);
  expect(result.reservation).toEqual({ ok: true, collisions: [] });
  expect(() => {
    assertNoPublicFix(lock, result.evidence);
  }).not.toThrow();
});

// --- case 3: patch-id ----------------------------------------------------------------

test("patch-id hit from a side-branch commit pins the --all history scan", async () => {
  const api = await loadAudit();
  const patch = mkGoodPatch([
    {
      path: "src/feature.ts",
      before: "export const f = 1;\n",
      after: "export const f = 2;\nexport const g = 3;\n",
    },
  ]);
  const repo = mkRepo();
  writeRepoFile(repo, "src/feature.ts", "export const f = 1;\n");
  commitAll(repo, "base feature");
  const patchFile = join(mkTmp("penumbra-audit-patch-"), "good.patch");
  writeFileSync(patchFile, patch, "utf8");
  onSideBranch(repo, "side-patch", () => {
    git(repo, ["apply", patchFile]);
    commitAll(repo, "apply good patch verbatim");
  });

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const { result } = await runAudit(api, { repo, lock, patch });

  const item = result.evidence["fam-op-canary/v1"];
  expect(item?.patch_id_hits).toBeGreaterThanOrEqual(1);
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("a good patch without a diff --git header rejects with HoldoutAuditError", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code");

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const plainPatch = [
    "--- a/src/plain.ts",
    "+++ b/src/plain.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "",
  ].join("\n");

  await expectAuditError(api, () => runAudit(api, { repo, lock, patch: plainPatch }));
});

// --- case 4: added-line scan -----------------------------------------------------------

test("added-line hit from a different patch-id counts as a hit", async () => {
  const api = await loadAudit();
  const probeLine = 'export const probeLine4a = "AUDIT-PROBE-4A-QUALIFYING-LINE";';
  const repo = mkRepo();
  writeRepoFile(repo, "src/seed.ts", "export const seed = 0;\n");
  commitAll(repo, "seed");
  onSideBranch(repo, "side-lines", () => {
    writeRepoFile(repo, "src/other-file.ts", `export const other = 1;\n${probeLine}\n`);
    commitAll(repo, "add shared line elsewhere");
  });

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const patch = mkGoodPatch([
    {
      path: "src/feature.ts",
      before: "export const f = 1;\n",
      after: `export const f = 1;\n${probeLine}\n`,
    },
  ]);
  const { result } = await runAudit(api, { repo, lock, patch });

  const item = result.evidence["fam-op-canary/v1"];
  expect(item?.patch_id_hits).toBe(0);
  expect(item?.added_line_hits).toBeGreaterThanOrEqual(1);
});

test("a shared added line under 24 non-whitespace chars is not a candidate", async () => {
  const api = await loadAudit();
  const shortLine = 'const marker4b = "x";';
  const longLine = 'export const unshared4b = "AUDIT-PROBE-4B-LONG-UNSHARED-LINE";';
  const repo = mkRepo();
  writeRepoFile(repo, "src/seed.ts", "export const seed = 0;\n");
  commitAll(repo, "seed");
  onSideBranch(repo, "side-short", () => {
    writeRepoFile(repo, "src/other-file.ts", `${shortLine}\n`);
    commitAll(repo, "add short shared line");
  });

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const patch = mkGoodPatch([
    {
      path: "src/feature.ts",
      before: "export const f = 1;\n",
      after: `export const f = 1;\n${shortLine}\n${longLine}\n`,
    },
  ]);
  const { result } = await runAudit(api, { repo, lock, patch });

  const item = result.evidence["fam-op-canary/v1"];
  expect(item?.patch_id_hits).toBe(0);
  expect(item?.added_line_hits).toBe(0);
});

test("candidate ranking keeps the top 5 by non-whitespace count", async () => {
  const api = await loadAudit();
  const lineA = `${" ".repeat(16)}${"q".repeat(25)}`;
  const ranked = ["r", "s", "t", "u", "v"].map((ch, i) => ch.repeat(30 + i));
  const repo = mkRepo();
  writeRepoFile(repo, "src/seed.ts", "export const seed = 0;\n");
  commitAll(repo, "seed");
  onSideBranch(repo, "side-rank", () => {
    writeRepoFile(repo, "src/rank-history.ts", `${lineA}\n`);
    commitAll(repo, "commit only line A");
  });

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const patch = mkGoodPatch([
    {
      path: "src/rank.ts",
      before: "const head = 0;\n",
      after: `const head = 0;\n${[lineA, ...ranked].join("\n")}\n`,
    },
  ]);
  const { result } = await runAudit(api, { repo, lock, patch });

  const item = result.evidence["fam-op-canary/v1"];
  expect(item?.patch_id_hits).toBe(0);
  expect(item?.added_line_hits).toBe(0);
});

test("a diff header path is not scanned as an added line", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/seed.ts", "export const seed = 0;\n");
  commitAll(repo, "seed");
  writeRepoFile(repo, "notes.txt", "x++ b/deep/nested/path/to/header_probe_file.ts\n");
  commitAll(repo, "add note line");

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const patch = mkGoodPatch([
    {
      path: "deep/nested/path/to/header_probe_file.ts",
      before: 'export const hp = "base";\n',
      after: 'export const hp = "base";\n// ok\n',
    },
  ]);
  const { result } = await runAudit(api, { repo, lock, patch });

  const item = result.evidence["fam-op-canary/v1"];
  expect(item?.patch_id_hits).toBe(0);
  expect(item?.added_line_hits).toBe(0);
});

test("the history scan never reaches argv as a git pickaxe", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/a.ts", "export const a = 1;\n");
  commitAll(repo, "a");
  onSideBranch(repo, "side-scan", () => {
    writeRepoFile(repo, "src/b.ts", "export const b = 2;\n");
    commitAll(repo, "b");
  });

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const { calls } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  const gitCalls = calls.filter((call) => call.cmd === "git");
  expect(gitCalls.length).toBeGreaterThan(0);
  for (const call of gitCalls) {
    for (const arg of call.args) {
      expect(arg.startsWith("-S")).toBe(false);
      expect(arg.startsWith("-G")).toBe(false);
    }
  }
});

// --- case 5: issue closure --------------------------------------------------------------

const PR_URL = "https://github.com/acme/widgets/pull/777";
const PR_URL_2 = "https://github.com/acme/widgets/pull/778";

function issueRef(url: string, owner = "acme", name = "widgets"): Record<string, unknown> {
  return { number: 777, url, repository: { name, owner: { login: owner } } };
}

function ghIssuePr(handlers: {
  issue?: RunCommandResult;
  pr?: (url: string) => RunCommandResult;
}): (args: string[]) => RunCommandResult {
  return (args) => {
    if (args.includes("issue")) {
      return handlers.issue ?? ghJson({});
    }
    if (args.includes("pr")) {
      const url = args.find((arg) => arg.startsWith("https://")) ?? "";
      return handlers.pr?.(url) ?? ghJson({});
    }
    return ghJson({});
  };
}

function mkIssueRepo(): { repo: string; ancestor: string } {
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  const ancestor = commitAll(repo, "base");
  writeRepoFile(repo, "src/y.ts", "export const y = 2;\n");
  commitAll(repo, "head");
  return { repo, ancestor };
}

test("closed issue fixed on HEAD history fails assertNoPublicFix", async () => {
  const api = await loadAudit();
  const { repo, ancestor } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL)],
    }),
    pr: () => ghJson({ mergeCommit: { oid: ancestor } }),
  });
  const { result, calls } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toEqual({
    state: "CLOSED",
    closing_commits: [{ sha: ancestor, is_ancestor_of_head: true }],
  });
  const issueCall = ghCalls(calls, "issue")[0];
  expect(issueCall).toBeDefined();
  const issueArgs = issueCall?.args ?? [];
  const repoFlag = issueArgs.findIndex(
    (arg, i) => arg === "--repo" && issueArgs[i + 1] === GH_REPO,
  );
  expect(repoFlag).toBeGreaterThanOrEqual(0);
  const prCall = ghCalls(calls, "pr")[0];
  expect(prCall?.args[2]).toBe(PR_URL);
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("closed issue fixed only on a side branch is not an ancestor of HEAD", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const sideSha = onSideBranch(repo, "side-fix", () => {
    writeRepoFile(repo, "src/z.ts", "export const z = 3;\n");
    return commitAll(repo, "side fix");
  });
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL)],
    }),
    pr: () => ghJson({ mergeCommit: { oid: sideSha } }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toEqual({
    state: "CLOSED",
    closing_commits: [{ sha: sideSha, is_ancestor_of_head: false }],
  });
  expect(() => {
    assertNoPublicFix(lock, result.evidence);
  }).not.toThrow();
});

test("an open issue reports an OPEN closure with no commits", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({ state: "OPEN", closedByPullRequestsReferences: [] }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toEqual({ state: "OPEN", closing_commits: [] });
  expect(() => {
    assertNoPublicFix(lock, result.evidence);
  }).not.toThrow();
});

test("gh issue view exiting non-zero yields a null closure", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("gh failed") },
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("gh issue view printing malformed JSON yields a null closure", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: {
      code: 0,
      stdout: Buffer.from("{not valid json", "utf8"),
      stderr: Buffer.alloc(0),
    },
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("an unknown merge oid yields a null closure, not a false ancestor", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL)],
    }),
    pr: () => ghJson({ mergeCommit: { oid: "f".repeat(40) } }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("closing PRs with a null mergeCommit are skipped", async () => {
  const api = await loadAudit();
  const { repo, ancestor } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL), issueRef(PR_URL_2)],
    }),
    pr: (url) =>
      url === PR_URL ? ghJson({ mergeCommit: null }) : ghJson({ mergeCommit: { oid: ancestor } }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toEqual({
    state: "CLOSED",
    closing_commits: [{ sha: ancestor, is_ancestor_of_head: true }],
  });
});

test("a cross-repo closing reference yields a null closure and no pr view", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL, "other", "repo")],
    }),
    pr: () => ghJson({ mergeCommit: { oid: "f".repeat(40) } }),
  });
  const { result, calls } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expect(ghCalls(calls, "pr")).toHaveLength(0);
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("gh pr view exits non-zero for one closing PR fails closed despite second non-ancestor PR", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const sideSha = onSideBranch(repo, "side-fix", () => {
    writeRepoFile(repo, "src/z.ts", "export const z = 3;\n");
    return commitAll(repo, "side fix");
  });
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL), issueRef(PR_URL_2)],
    }),
    pr: (url) =>
      url === PR_URL
        ? { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("rate limited") }
        : ghJson({ mergeCommit: { oid: sideSha } }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("gh pr view returns malformed JSON fails closed", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL)],
    }),
    pr: () => ({
      code: 0,
      stdout: Buffer.from("{not valid json", "utf8"),
      stderr: Buffer.alloc(0),
    }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

test("gh pr view returns schema failure fails closed", async () => {
  const api = await loadAudit();
  const { repo } = mkIssueRepo();
  const lock = mkLock([mkEntry(ISSUE_ROOT, "v1", false)]);
  const gh = ghIssuePr({
    issue: ghJson({
      state: "CLOSED",
      closedByPullRequestsReferences: [issueRef(PR_URL)],
    }),
    pr: () => ghJson({ mergeCommit: "not-an-object" }),
  });
  const { result } = await runAudit(api, {
    repo,
    lock,
    patch: cleanPatch(),
    hooks: { gh },
  });

  const item = result.evidence["fam-4242/v1"];
  expect(item?.issue_closure).toBeNull();
  expectPublicFixError(() => {
    assertNoPublicFix(lock, result.evidence);
  });
});

// --- case 6: reservation over all history ------------------------------------------------

function mkRepoWithCommittedFixture(
  fixturePath: string,
  content: string,
  opts: { deleteAfter?: boolean } = {},
): { repo: string; addSha: string } {
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code");
  writeRepoFile(repo, fixturePath, content);
  const addSha = commitAll(repo, "add fixture");
  if (opts.deleteAfter === true) {
    git(repo, ["rm", "-q", fixturePath]);
    commitAll(repo, "remove fixture");
  }
  return { repo, addSha };
}

test("reservation flags a root collision from deleted fixture history", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-canary/v1/fixture.json`;
  const { repo, addSha } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJson({
      family_id: "fam-op-canary",
      variant_id: "v1",
      root: OP_ROOT,
      failure_type: "missed_commit",
    }),
    { deleteAfter: true },
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toEqual([
    {
      commit: addSha,
      path: fixturePath,
      fixture_family_id: "fam-op-canary",
      fixture_variant_id: "v1",
      lock_family_id: "fam-op-canary",
      lock_variant_id: "v9",
      via: "root",
    },
  ]);
});

test("reservation flags a reconstructs collision", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-syn-recon-fixture/v1/fixture.json`;
  const { repo, addSha } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJson({
      family_id: "fam-syn-recon-fixture",
      variant_id: "v1",
      root: { kind: "synthetic", id: "recon-fixture" },
      reconstructs: OP_ROOT,
      synthetic: true,
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toEqual([
    {
      commit: addSha,
      path: fixturePath,
      fixture_family_id: "fam-syn-recon-fixture",
      fixture_variant_id: "v1",
      lock_family_id: "fam-op-canary",
      lock_variant_id: "v9",
      via: "reconstructs",
    },
  ]);
});

test("a colliding fixture outside the prefix is ignored", async () => {
  const api = await loadAudit();
  const fixturePath = "tools/fixtures/fam-op-canary/v1/fixture.json";
  const { repo } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJson({
      family_id: "fam-op-canary",
      variant_id: "v1",
      root: OP_ROOT,
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation).toEqual({ ok: true, collisions: [] });
});

test("unparseable fixture blobs each yield one unparseable collision", async () => {
  const api = await loadAudit();
  const badJsonPath = `${FIXTURES_PREFIX}fam-bad-json/v1/fixture.json`;
  const badRootPath = `${FIXTURES_PREFIX}fam-bad-root/v1/fixture.json`;
  const badRootJson = fixtureJson({
    family_id: "fam-0",
    variant_id: "v1",
    root: { kind: "issue", number: 0 },
    failure_type: "missed_commit",
  });
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code");
  writeRepoFile(repo, badJsonPath, "{ not valid json");
  writeRepoFile(repo, badRootPath, badRootJson);
  commitAll(repo, "add broken fixtures");

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toHaveLength(2);
  for (const collision of result.reservation.collisions) {
    expect(collision.via).toBe("unparseable");
    expect(collision.lock_family_id).toBe("");
    expect(collision.lock_variant_id).toBe("");
  }
});

test("multiple non-synthetic entries yield exactly one collision per unparseable blob", async () => {
  const api = await loadAudit();
  const badJsonPath = `${FIXTURES_PREFIX}fam-bad-json/v1/fixture.json`;
  const badRootPath = `${FIXTURES_PREFIX}fam-bad-root/v1/fixture.json`;
  const badRootJson = fixtureJson({
    family_id: "fam-0",
    variant_id: "v1",
    root: { kind: "issue", number: 0 },
    failure_type: "missed_commit",
  });
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code");
  writeRepoFile(repo, badJsonPath, "{ not valid json");
  writeRepoFile(repo, badRootPath, badRootJson);
  commitAll(repo, "add broken fixtures");

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false), mkEntry(ISSUE_ROOT, "v2", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toHaveLength(2);
  for (const collision of result.reservation.collisions) {
    expect(collision.via).toBe("unparseable");
    expect(collision.lock_family_id).toBe("");
    expect(collision.lock_variant_id).toBe("");
  }
});

test("reservation passes when history fixtures do not collide", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-other/v1/fixture.json`;
  const { repo } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJson({
      family_id: "fam-op-other",
      variant_id: "v1",
      root: { kind: "operator_bundle", id: "other" },
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation).toEqual({ ok: true, collisions: [] });
});

test("a fixture.json with no reconstructs key (raw JSON) reserves cleanly when root matches no lock entry", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-norecon/v1/fixture.json`;
  const rawJson = `{
  "schema_version": 1,
  "family_id": "fam-op-other",
  "variant_id": "v1",
  "root": { "kind": "operator_bundle", "id": "other" },
  "failure_type": "missed_commit",
  "split": "holdout",
  "synthetic": false,
  "base_sha": "${"a".repeat(40)}",
  "task_digest": "${"b".repeat(64)}",
  "source_root_handoff_digests": [],
  "expect_blocked": false,
  "hidden_ref": { "assertion_set_digest": "${"c".repeat(64)}" },
  "content_digest": "${"d".repeat(64)}"
}\n`;
  const { repo } = mkRepoWithCommittedFixture(fixturePath, rawJson);

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation).toEqual({ ok: true, collisions: [] });
});

test("a fixture.json with no reconstructs key (raw JSON) and matching OP_ROOT yields exactly one root collision", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-canary/v1/fixture.json`;
  const actualRepo = mkRepo();
  writeRepoFile(actualRepo, "src/x.ts", "export const x = 1;\n");
  commitAll(actualRepo, "code");
  const rawJson = `{
  "schema_version": 1,
  "family_id": "fam-op-canary",
  "variant_id": "v1",
  "root": { "kind": "operator_bundle", "id": "canary" },
  "failure_type": "missed_commit",
  "split": "holdout",
  "synthetic": false,
  "base_sha": "${"a".repeat(40)}",
  "task_digest": "${"b".repeat(64)}",
  "source_root_handoff_digests": [],
  "expect_blocked": false,
  "hidden_ref": { "assertion_set_digest": "${"c".repeat(64)}" },
  "content_digest": "${"d".repeat(64)}"
}\n`;
  writeRepoFile(actualRepo, fixturePath, rawJson);
  commitAll(actualRepo, "add fixture");

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo: actualRepo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  const expectedCollision: AuditCollision = {
    commit: headSha(actualRepo),
    path: fixturePath,
    fixture_family_id: "fam-op-canary",
    fixture_variant_id: "v1",
    lock_family_id: "fam-op-canary",
    lock_variant_id: "v9",
    via: "root",
  };
  expect(result.reservation.collisions).toEqual([expectedCollision]);
  for (const collision of result.reservation.collisions) {
    expect(collision.via).not.toBe("unparseable");
  }
});

test("valid root + invalid non-null reconstructs yields one unparseable collision", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-probe/v1/fixture.json`;
  const { repo, addSha } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJsonRaw({
      family_id: "fam-op-probe",
      variant_id: "v1",
      root: { kind: "operator_bundle", id: "probe-x" },
      reconstructs: { kind: "operator_bundle", id: "canary", note: "reused" },
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toEqual([
    {
      commit: addSha,
      path: fixturePath,
      fixture_family_id: "fam-op-probe",
      fixture_variant_id: "v1",
      lock_family_id: "",
      lock_variant_id: "",
      via: "unparseable",
    },
  ]);
});

test("invalid root + valid non-matching reconstructs yields one unparseable collision", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-badroot-validrecon/v1/fixture.json`;
  const { repo, addSha } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJsonRaw({
      family_id: "fam-badroot-validrecon",
      variant_id: "v1",
      root: { kind: "operator_bundle", id: "bad-root", extraKey: "should-fail" },
      reconstructs: { kind: "operator_bundle", id: "other" },
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toEqual([
    {
      commit: addSha,
      path: fixturePath,
      fixture_family_id: "fam-badroot-validrecon",
      fixture_variant_id: "v1",
      lock_family_id: "",
      lock_variant_id: "",
      via: "unparseable",
    },
  ]);
});

test("valid root + null reconstructs parses normally (no unparseable collision)", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-probe/v1/fixture.json`;
  const { repo } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJson({
      family_id: "fam-op-probe",
      variant_id: "v1",
      root: { kind: "operator_bundle", id: "probe-x" },
      reconstructs: null,
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation).toEqual({ ok: true, collisions: [] });
});

test("valid root matching a lock entry with invalid non-null reconstructs yields one unparseable collision", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-op-matchlock-badrecon/v1/fixture.json`;
  const { repo, addSha } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJsonRaw({
      family_id: "fam-op-matchlock-badrecon",
      variant_id: "v1",
      root: OP_ROOT,
      reconstructs: { kind: "bogus" },
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toEqual([
    {
      commit: addSha,
      path: fixturePath,
      fixture_family_id: "fam-op-matchlock-badrecon",
      fixture_variant_id: "v1",
      lock_family_id: "",
      lock_variant_id: "",
      via: "unparseable",
    },
  ]);
});

test("invalid root plus valid reconstructs matching a lock entry yields one unparseable collision", async () => {
  const api = await loadAudit();
  const fixturePath = `${FIXTURES_PREFIX}fam-badroot-matchlock/v1/fixture.json`;
  const { repo, addSha } = mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJsonRaw({
      family_id: "fam-badroot-matchlock",
      variant_id: "v1",
      root: { kind: "operator_bundle", id: "bad-root", extraKey: "should-fail" },
      reconstructs: OP_ROOT,
      failure_type: "missed_commit",
    }),
  );

  const lock = mkLock([mkEntry(OP_ROOT, "v9", false)]);
  const { result } = await runAudit(api, { repo, lock, patch: cleanPatch() });

  expect(result.reservation.ok).toBe(false);
  expect(result.reservation.collisions).toEqual([
    {
      commit: addSha,
      path: fixturePath,
      fixture_family_id: "fam-badroot-matchlock",
      fixture_variant_id: "v1",
      lock_family_id: "",
      lock_variant_id: "",
      via: "unparseable",
    },
  ]);
});

// --- case 7: lock digest -----------------------------------------------------------------

test("a lock with a wrong digest rejects with HoldoutLockError before any run", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code");

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const badLock: HoldoutLock = { ...lock, digest: "0".repeat(64) };
  const patchCalls: HoldoutLockEntry[] = [];
  const { run, calls } = mkRunner();

  let caught: unknown;
  try {
    await api.auditHoldoutRoots({
      repoRoot: repo,
      lock: badLock,
      readGoodPatch: mkPatchReader(cleanPatch(), patchCalls),
      run,
      ghRepo: GH_REPO,
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HoldoutLockError);
  expect(calls).toHaveLength(0);
  expect(patchCalls).toHaveLength(0);
});

// --- case 8: fail-closed git ----------------------------------------------------------------

function mkRepoWithNonCollidingFixture(): string {
  const fixturePath = `${FIXTURES_PREFIX}fam-op-other/v1/fixture.json`;
  return mkRepoWithCommittedFixture(
    fixturePath,
    fixtureJson({
      family_id: "fam-op-other",
      variant_id: "v1",
      root: { kind: "operator_bundle", id: "other" },
      failure_type: "missed_commit",
    }),
  ).repo;
}

const FAIL_CLOSED_SCENARIOS: [string, (cmd: string, args: string[]) => boolean][] = [
  [
    "git log --all -p history scan",
    (cmd, args): boolean => cmd === "git" && args.includes("log") && args.includes("-p"),
  ],
  ["git patch-id", (cmd, args): boolean => cmd === "git" && args.includes("patch-id")],
  [
    "git log --raw reservation scan",
    (cmd, args): boolean => cmd === "git" && args.includes("log") && args.includes("--raw"),
  ],
  ["git cat-file blob", (cmd, args): boolean => cmd === "git" && args.includes("cat-file")],
  ["git rev-parse HEAD", (cmd, args): boolean => cmd === "git" && args.includes("rev-parse")],
];

for (const [name, predicate] of FAIL_CLOSED_SCENARIOS) {
  test(`fail-closed: ${name} failure rejects with HoldoutAuditError`, async () => {
    const api = await loadAudit();
    const repo = mkRepoWithNonCollidingFixture();
    const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
    const injected: RunCommandResult = {
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("injected git failure"),
    };
    const { run } = mkRunner({
      fail: (cmd, args) => (predicate(cmd, args) ? injected : null),
    });

    await expectAuditError(api, () =>
      api.auditHoldoutRoots({
        repoRoot: repo,
        lock,
        readGoodPatch: mkPatchReader(cleanPatch()),
        run,
        ghRepo: GH_REPO,
      }),
    );
  });
}

// --- case 9: GIT_* env scrubbing --------------------------------------------------------------

test("git calls scrub GIT_* env even when process.env is poisoned", async () => {
  const api = await loadAudit();
  const repo = mkRepo();
  writeRepoFile(repo, "src/x.ts", "export const x = 1;\n");
  commitAll(repo, "code one");
  writeRepoFile(repo, "src/y.ts", "export const y = 2;\n");
  commitAll(repo, "code two");

  const lock = mkLock([mkEntry(OP_ROOT, "v1", false)]);
  const { run, calls } = mkRunner();
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nonexistent/penumbra-audit-gitdir";
  try {
    const result = await api.auditHoldoutRoots({
      repoRoot: repo,
      lock,
      readGoodPatch: mkPatchReader(cleanPatch()),
      run,
      ghRepo: GH_REPO,
    });

    expect(result.head_sha).toBe(headSha(repo));
    const item = result.evidence["fam-op-canary/v1"];
    expect(item?.patch_id_hits).toBe(0);
    expect(item?.added_line_hits).toBe(0);
    expect(item?.issue_closure).toBeNull();
    expect(result.reservation).toEqual({ ok: true, collisions: [] });
    for (const call of calls) {
      for (const key of Object.keys(call.opts?.env ?? {})) {
        expect(key.startsWith("GIT_")).toBe(false);
      }
    }
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = previous;
    }
  }
});
