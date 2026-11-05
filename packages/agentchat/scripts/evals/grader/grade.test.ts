import { taskDigest } from "@penumbra/core/evals/canonical";
import {
  assertionSetDigest,
  bundleContentDigest,
  FixturePublicSchema,
  type HoldoutBundle,
  HoldoutBundleSchema,
} from "@penumbra/core/evals/fixture";
import {
  type ReceiptClaimBody,
  ReceiptClaimSchema,
  receiptDigest,
} from "@penumbra/core/evals/manifest";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type * as ControlModule from "./control.js";
import type { DependencyProvider } from "./deps.js";
import type * as GradeModule from "./grade.js";

import { graderBuildId, runGraderBundle } from "./build-id.js";
import { materialize } from "./materialize.js";
import { detectSandbox, type SandboxKind, type SpawnFn } from "./sandbox.js";
import { type GraderScratch, openGraderScratch } from "./scratch.js";

// grade.ts / control.ts / evaluate.ts do not exist yet: `typeof GradeModule`
// is unusable at RED time, so the P9b surface is declared structurally below
// and the namespace aliases keep the intended link visible.
type ControlModuleApi = typeof ControlModule;
type GradeModuleApi = typeof GradeModule;

type CompareFn = (observed: unknown, expected: unknown) => boolean;

interface FixtureRef {
  family_id: string;
  variant_id: string;
}

interface GradeInput {
  fixture_ref: FixtureRef;
  base_sha: string;
  final_sha: string;
}

interface GradeCtx {
  bundle: HoldoutBundle;
  scratch: GraderScratch;
  controls: ControlCacheLike;
  deps: DependencyProvider;
  sandbox: SandboxKind;
  spawn?: SpawnFn;
  timeoutMs: number;
}

interface GradeApi {
  grade(input: GradeInput, ctx: GradeCtx): Promise<unknown>;
  seededShuffle: (items: readonly unknown[], seed: number) => unknown[];
}

interface ControlResult {
  verdict: string;
}

type EnsureOutcome = { ok: true; key: string; control: ControlResult } | { ok: false; key: string };

interface ControlCacheLike {
  ensure(ref: FixtureRef, bundle: HoldoutBundle): Promise<EnsureOutcome>;
}

interface ControlCacheOpts {
  scratch: GraderScratch;
  sandbox: SandboxKind;
  deps: DependencyProvider;
  buildId: string;
  spawn?: SpawnFn;
  timeoutMs: number;
  compare?: CompareFn;
  comparatorId?: string;
}

interface QualifyOpts {
  bundle: HoldoutBundle;
  scratch: GraderScratch;
  baseSha: string;
  sandbox: SandboxKind;
  deps: DependencyProvider;
  buildId: string;
  spawn?: SpawnFn;
  timeoutMs: number;
  compare?: CompareFn;
}

interface SelfQualifyOpts extends QualifyOpts {
  control: ControlResult;
}

type SelfQualifyOutcome = { ok: true } | { ok: false; reason: string };

interface ControlApi {
  ControlCache: new (opts: ControlCacheOpts) => ControlCacheLike;
  controlKey(ref: FixtureRef, buildId: string, comparatorId?: string): string;
  comparatorIdentity(compare: CompareFn | undefined, comparatorId?: string): string;
  qualifyControl(ref: FixtureRef, opts: QualifyOpts): Promise<ControlResult>;
  selfQualify(ref: FixtureRef, opts: SelfQualifyOpts): Promise<SelfQualifyOutcome>;
}

// --- candidate source bodies -----------------------------------------------

const VALIDATE_HEAD = `const SPLITS = new Set(["train", "dev", "holdout"]);

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFixture(obj: unknown): { ok: boolean; errors: string[] } {
  if (!isPlain(obj)) {
    return { ok: false, errors: ["not_object"] };
  }
  const errors: string[] = [];
  if (obj.schema_version !== 1) {
    errors.push("bad_schema_version");
  }
  if (typeof obj.family_id !== "string" || !obj.family_id.startsWith("fam-")) {
    errors.push("bad_family_id");
  }
  if (typeof obj.split !== "string" || !SPLITS.has(obj.split)) {
    errors.push("bad_split");
  }
  const rootKind = isPlain(obj.root) ? obj.root.kind : undefined;
  if (obj.synthetic !== (rootKind === "synthetic")) {
    errors.push("synthetic_mismatch");
  }
  return { ok: errors.length === 0, errors };
}
`;

const VALIDATE_HEAD_NO_SYNTH = `const SPLITS = new Set(["train", "dev", "holdout"]);

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFixture(obj: unknown): { ok: boolean; errors: string[] } {
  if (!isPlain(obj)) {
    return { ok: false, errors: ["not_object"] };
  }
  const errors: string[] = [];
  if (obj.schema_version !== 1) {
    errors.push("bad_schema_version");
  }
  if (typeof obj.family_id !== "string" || !obj.family_id.startsWith("fam-")) {
    errors.push("bad_family_id");
  }
  if (typeof obj.split !== "string" || !SPLITS.has(obj.split)) {
    errors.push("bad_split");
  }
  return { ok: errors.length === 0, errors };
}
`;

const SUMMARIZE_GOOD = `export function summarize(list: unknown[]): { valid: number; invalid: number } {
  let valid = 0;
  for (const item of list) {
    if (validateFixture(item).ok) {
      valid += 1;
    }
  }
  return { valid, invalid: list.length - valid };
}
`;

const DEDUPE_GOOD = `export function dedupe(list: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of list) {
    const key = JSON.stringify(item) ?? "undefined";
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
`;

const GOOD_VALIDATE_TS = `${VALIDATE_HEAD}\n${SUMMARIZE_GOOD}\n${DEDUPE_GOOD}`;
const BAD_VALIDATE_TS = `${VALIDATE_HEAD_NO_SYNTH}\n${SUMMARIZE_GOOD}\n${DEDUPE_GOOD}`;

const BAD_LOG_TS = `console.log("RESULT: PASS");
console.error("RESULT: PASS");

${BAD_VALIDATE_TS}`;

const MEMO_TS = `${VALIDATE_HEAD}
let c: number | undefined;

export const summarize = (_list: unknown[]): number => c ??= Math.random();
`;

const ORDER_TS = `JSON.stringify = () => "{}";
Array.prototype.sort = function () {
  return this;
};

${VALIDATE_HEAD}
export const summarize = (list: unknown[]): unknown => list[0];
`;

const SPIN_TS = `while (true) {}

export function validateFixture(_obj: unknown): { ok: boolean; errors: string[] } {
  return { ok: true, errors: [] };
}

export function summarize(_list: unknown[]): { valid: number; invalid: number } {
  return { valid: 0, invalid: 0 };
}
`;

const POISON_TS = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  "",
  'writeFileSync(`${process.env.HOME}/poison`, "poison\\n");',
  'writeFileSync(`${process.env.TMPDIR}/poison`, "poison\\n");',
  "mkdirSync(`${process.env.HOME}/.bun/install/cache`, { recursive: true });",
  'writeFileSync(`${process.env.HOME}/.bun/install/cache/poison`, "poison\\n");',
  "",
  "while (true) {}",
  "",
  "export function validateFixture(_obj: unknown): { ok: boolean; errors: string[] } {",
  "  return { ok: true, errors: [] };",
  "}",
  "",
].join("\n");

// Forgery lives only on the direct validateFixture entry point (the path the
// probe assertions call); summarize goes through the non-forging internal
// validator, so only the probe leg tampers and the invariant legs stay clean.
const FORGE_PROBE_TS = `import { writeSync } from "node:fs";

${VALIDATE_HEAD.replace("export function validateFixture(", "function checkFixture(")}
export function validateFixture(obj: unknown): { ok: boolean; errors: string[] } {
  try {
    writeSync(3, "forged nonce {}\\n");
  } catch {
    // fd 3 is only open inside probe legs; the forgery is best-effort.
  }
  return checkFixture(obj);
}

export function summarize(list: unknown[]): { valid: number; invalid: number } {
  let valid = 0;
  for (const item of list) {
    if (checkFixture(item).ok) {
      valid += 1;
    }
  }
  return { valid, invalid: list.length - valid };
}

${DEDUPE_GOOD}`;

const FORGE_INVARIANT_TS = `import { writeSync } from "node:fs";

${VALIDATE_HEAD}
export function summarize(list: unknown[]): { valid: number; invalid: number } {
  try {
    writeSync(3, "forged nonce {}\\n");
  } catch {
    // fd 3 is only open inside probe legs; the forgery is best-effort.
  }
  let valid = 0;
  for (const item of list) {
    if (validateFixture(item).ok) {
      valid += 1;
    }
  }
  return { valid, invalid: list.length - valid };
}

${DEDUPE_GOOD}`;

const SPIN_SUMMARIZE_TS = `${VALIDATE_HEAD}
export function summarize(_list: unknown[]): { valid: number; invalid: number } {
  while (true) {}
}

${DEDUPE_GOOD}`;

const THROWING_DEDUPE_TS = `${VALIDATE_HEAD}
${SUMMARIZE_GOOD}
export function dedupe(_list: unknown[]): unknown[] {
  throw new Error("dedupe unavailable");
}
`;

const SENTINEL_VALIDATE_TS = `const SPLITS = new Set(["train", "dev", "holdout"]);

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFixture(obj: unknown): { ok: boolean; errors: string[] } {
  if (!isPlain(obj)) {
    return { ok: false, errors: ["not_object"], sentinel: true };
  }
  const errors: string[] = [];
  if (obj.schema_version !== 1) {
    errors.push("bad_schema_version");
  }
  if (typeof obj.family_id !== "string" || !obj.family_id.startsWith("fam-")) {
    errors.push("bad_family_id");
  }
  if (typeof obj.split !== "string" || !SPLITS.has(obj.split)) {
    errors.push("bad_split");
  }
  const rootKind = isPlain(obj.root) ? obj.root.kind : undefined;
  if (obj.synthetic !== (rootKind === "synthetic")) {
    errors.push("synthetic_mismatch");
  }
  return { ok: errors.length === 0, errors, sentinel: true };
}
`;

const SENTINEL_TS = `${SENTINEL_VALIDATE_TS}\n${SUMMARIZE_GOOD}\n${DEDUPE_GOOD}`;

const ZOD_HEAD = `import { z } from "zod";

const splitSchema = z.enum(["train", "dev", "holdout"]);
const familySchema = z.string().startsWith("fam-");

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFixture(obj: unknown): { ok: boolean; errors: string[] } {
  if (!isPlain(obj)) {
    return { ok: false, errors: ["not_object"] };
  }
  const errors: string[] = [];
  if (obj.schema_version !== 1) {
    errors.push("bad_schema_version");
  }
  if (!familySchema.safeParse(obj.family_id).success) {
    errors.push("bad_family_id");
  }
  if (!splitSchema.safeParse(obj.split).success) {
    errors.push("bad_split");
  }
  const rootKind = isPlain(obj.root) ? obj.root.kind : undefined;
  if (obj.synthetic !== (rootKind === "synthetic")) {
    errors.push("synthetic_mismatch");
  }
  return { ok: errors.length === 0, errors };
}
`;

const ZOD_HEAD_NO_SYNTH = `import { z } from "zod";

const splitSchema = z.enum(["train", "dev", "holdout"]);
const familySchema = z.string().startsWith("fam-");

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFixture(obj: unknown): { ok: boolean; errors: string[] } {
  if (!isPlain(obj)) {
    return { ok: false, errors: ["not_object"] };
  }
  const errors: string[] = [];
  if (obj.schema_version !== 1) {
    errors.push("bad_schema_version");
  }
  if (!familySchema.safeParse(obj.family_id).success) {
    errors.push("bad_family_id");
  }
  if (!splitSchema.safeParse(obj.split).success) {
    errors.push("bad_split");
  }
  return { ok: errors.length === 0, errors };
}
`;

const ZOD_GOOD_TS = `${ZOD_HEAD}\n${SUMMARIZE_GOOD}\n${DEDUPE_GOOD}`;
const ZOD_BAD_TS = `${ZOD_HEAD_NO_SYNTH}\n${SUMMARIZE_GOOD}\n${DEDUPE_GOOD}`;

const BUNFIG_TOML = 'preload = ["./evil.ts"]\n';
const EVIL_LOG_TS = 'console.log("RESULT: PASS");\n';
const EVIL_THROW_TS = 'throw new Error("preloaded");\n';
const PKG_WITH_BUN =
  '{"name":"contract-validator","private":true,"type":"module","bun":{"test":{"preload":["./evil.ts"]}}}\n';
const ENV_FILE = "SECRET=canary\n";

// --- harness ---------------------------------------------------------------

const FIX_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "evals",
  "synthetic",
  "syn-contract-validator",
);

const TASK = "Implement the contract validator described by test/validate.test.ts.";
const GRADE_URL = new URL("./grade.ts", import.meta.url).href;
const CONTROL_URL = new URL("./control.ts", import.meta.url).href;
const SHA40 = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[0-9a-f]{64}$/;
const ALL_IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];

const HOST_SANDBOX_KIND = await detectSandbox();

let buildId = "";

beforeAll(async () => {
  buildId = await graderBuildId();
});

const tempDirs: string[] = [];
const scratches: GraderScratch[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function mkScratch(): Promise<GraderScratch> {
  const scratch = await openGraderScratch({ sourceRepo: null });
  scratches.push(scratch);
  return scratch;
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX_DIR, name), "utf8")) as Record<string, unknown>;
}

async function loadGrade(): Promise<GradeApi> {
  const mod = (await import(GRADE_URL).catch(() => null)) as GradeApi | null;
  expect(mod).not.toBeNull();
  return mod!;
}

async function loadControl(): Promise<ControlApi> {
  const mod = (await import(CONTROL_URL).catch(() => null)) as ControlApi | null;
  expect(mod).not.toBeNull();
  return mod!;
}

// Cache dir handed to the fake provider: node_modules/zod is symlinked to the
// real workspace package so zod-importing candidates resolve it in-tree.
function zodCacheDir(): string {
  const dir = mkTmp("penumbra-grade-deps-");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(
    dirname(Bun.resolveSync("zod/package.json", import.meta.dir)),
    join(dir, "node_modules", "zod"),
    "dir",
  );
  return dir;
}

function fakeDeps(cacheDir: string): DependencyProvider {
  return { ensure: () => Promise.resolve({ ok: true, cacheDir }) };
}

// --- spawn recording ---------------------------------------------------------

interface ProbePayload {
  nonce: string;
  module_rel: string;
  tree: string;
  calls: { id: string; export: string; input: unknown }[];
}

interface ProbeRecord {
  env: NodeJS.ProcessEnv | undefined;
  stdin: Buffer[];
}

type LegClass = "control" | "selfq" | "candidate" | "other";

// The spawn options carry the frame-file path under a module-private symbol;
// it is identified by description so the suite can assert where the frame
// lands without the implementation exporting the symbol. Mirrors
// sandbox.test.ts / sandbox.ts defaultProbeSpawn.
function fd3PathFromOpts(opts: unknown): string | null {
  if (typeof opts !== "object" || opts === null) {
    return null;
  }
  for (const sym of Object.getOwnPropertySymbols(opts)) {
    if (sym.description === "penumbra.probe-fd3") {
      const value: unknown = Reflect.get(opts, sym);
      return typeof value === "string" ? value : null;
    }
  }
  return null;
}

// A pass-through SpawnFn that runs REAL children, honoring the fd-3 frame file
// exactly like sandbox.ts defaultProbeSpawn while recording the env and the
// JSON payload written to stdin.
function recordingSpawn(records: ProbeRecord[]): SpawnFn {
  const spawnFn: SpawnFn = (cmd, args, opts) => {
    const rec: ProbeRecord = { env: opts?.env, stdin: [] };
    records.push(rec);
    const fd3Path = fd3PathFromOpts(opts);
    const baseStdio = opts?.stdio;
    let child: ChildProcess;
    if (fd3Path === null || !Array.isArray(baseStdio) || baseStdio.length < 4) {
      child = spawn(cmd, args, { cwd: opts?.cwd, env: opts?.env, stdio: baseStdio });
    } else {
      const fd3 = openSync(fd3Path, "a");
      try {
        child = spawn(cmd, args, {
          cwd: opts?.cwd,
          env: opts?.env,
          stdio: baseStdio.map((entry, i) => (i === 3 ? fd3 : entry)),
        });
      } finally {
        closeSync(fd3);
      }
    }
    if (child.stdin !== null) {
      const stdin = child.stdin;
      const original = stdin.write.bind(stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
      stdin.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        rec.stdin.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return original(chunk, ...rest);
      };
    }
    return child;
  };
  return spawnFn;
}

function payloadOf(rec: ProbeRecord): ProbePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(rec.stdin).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return parsed as ProbePayload;
}

function clsOf(rec: ProbeRecord): LegClass {
  const name = basename(payloadOf(rec)?.tree ?? "");
  if (name.startsWith("control")) {
    return "control";
  }
  if (name.startsWith("selfq-")) {
    return "selfq";
  }
  if (name.startsWith("cand-")) {
    return "candidate";
  }
  return "other";
}

function legRootOf(rec: ProbeRecord): string {
  const home = rec.env?.HOME;
  return home === undefined ? "" : dirname(home);
}

function countCls(records: ProbeRecord[], cls: LegClass): number {
  return records.filter((rec) => clsOf(rec) === cls).length;
}

function countControlSelfq(records: ProbeRecord[]): number {
  return records.filter((rec) => {
    const cls = clsOf(rec);
    return cls === "control" || cls === "selfq";
  }).length;
}

function callsWithId(records: ProbeRecord[], cls: LegClass, id: string): unknown[] {
  const inputs: unknown[] = [];
  for (const rec of records) {
    if (clsOf(rec) !== cls) {
      continue;
    }
    for (const call of payloadOf(rec)?.calls ?? []) {
      if (call.id === id) {
        inputs.push(call.input);
      }
    }
  }
  return inputs;
}

// --- git helpers -------------------------------------------------------------

async function gitOk(scratch: GraderScratch, args: string[], input?: Uint8Array): Promise<string> {
  const res = await scratch.git(args, input);
  expect(res.code).toBe(0);
  return res.stdout.toString("utf8").trim();
}

// Serial by contract: buildBase/applyPatch share the scratch index, so callers
// must await each call before issuing the next.
async function commitFiles(
  scratch: GraderScratch,
  parent: string | null,
  changes: Record<string, string>,
  opts?: { symlinks?: Record<string, string> },
): Promise<string> {
  await gitOk(scratch, parent === null ? ["read-tree", "--empty"] : ["read-tree", parent]);
  for (const [path, content] of Object.entries(changes)) {
    const oid = await gitOk(scratch, ["hash-object", "-w", "--stdin"], Buffer.from(content));
    await gitOk(scratch, ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`]);
  }
  for (const [path, target] of Object.entries(opts?.symlinks ?? {})) {
    const oid = await gitOk(scratch, ["hash-object", "-w", "--stdin"], Buffer.from(target));
    await gitOk(scratch, ["update-index", "--add", "--cacheinfo", `120000,${oid},${path}`]);
  }
  const tree = await gitOk(scratch, ["write-tree"]);
  const args = ["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", "cand"];
  return await gitOk(scratch, args);
}

async function patchBetween(scratch: GraderScratch, base: string, sha: string): Promise<string> {
  const res = await scratch.git(["diff", base, sha]);
  expect(res.code).toBe(0);
  return res.stdout.toString("utf8");
}

// --- assertion helpers ---------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  // Compare the key lists element-wise: recursing into deepEqual(keysA, keysB)
  // compares the key arrays structurally, and Object.keys of an index-keyed
  // array reproduces the array, so distinct objects recursed forever.
  if (keysA.length !== keysB.length || !keysA.every((key, i) => key === keysB[i])) {
    return false;
  }
  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function stripSentinel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSentinel(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "sentinel") {
        out[key] = stripSentinel(entry);
      }
    }
    return out;
  }
  return value;
}

const stripSentinelCompare: CompareFn = (observed, expected) =>
  deepEqual(stripSentinel(observed), stripSentinel(expected));

function parseReceipt(res: unknown): ReceiptClaimBody {
  const parsed = ReceiptClaimSchema.safeParse(res);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("unreachable: receipt did not parse");
  }
  return parsed.data;
}

function perCheckMap(receipt: ReceiptClaimBody): Map<string, boolean> {
  return new Map(
    (receipt.per_check ?? []).map((check: { id: string; ok: boolean }) => [check.id, check.ok]),
  );
}

function expectChecks(receipt: ReceiptClaimBody, expected: Record<string, boolean>): void {
  const map = perCheckMap(receipt);
  for (const [id, ok] of Object.entries(expected)) {
    expect(map.get(id)).toBe(ok);
  }
}

function expectAllOk(receipt: ReceiptClaimBody, ids: string[]): void {
  const map = perCheckMap(receipt);
  for (const id of ids) {
    expect(map.get(id)).toBe(true);
  }
}

function pickOrderSeed(
  shuffle: (items: readonly unknown[], seed: number) => unknown[],
  input: readonly unknown[],
): number | null {
  for (const seed of Array.from({ length: 2048 }, (_unused, i) => i)) {
    const out = shuffle(input, seed);
    if (Array.isArray(out) && out.length === input.length && !deepEqual(out[0], input[0])) {
      return seed;
    }
  }
  return null;
}

function findNamed(root: string, name: string): string[] {
  const hits: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) {
      hits.push(...findNamed(p, name));
    } else if (ent.name === name) {
      hits.push(p);
    }
  }
  return hits;
}

// --- per-test setup ----------------------------------------------------------

interface Setup {
  api: GradeApi;
  ctl: ControlApi;
  scratch: GraderScratch;
  base: string;
  bundle: HoldoutBundle;
  repoFiles: Record<string, string>;
  deps: DependencyProvider;
  ref: FixtureRef;
  c7Input: unknown[];
  c7Seed: number;
}

function c7InputFrom(bundleJson: Record<string, unknown>): unknown[] {
  const assertions = bundleJson.assertions as { id: string; inputs?: unknown[] }[];
  const c7 = assertions.find((a) => a.id === "c7");
  const input = c7?.inputs?.[0];
  expect(Array.isArray(input)).toBe(true);
  return input as unknown[];
}

async function setup(): Promise<Setup> {
  const api = await loadGrade();
  const ctl = await loadControl();
  const scratch = await mkScratch();
  const repoFiles = readJson("repo.files.json") as Record<string, string>;
  const bundleJson = readJson("bundle.json");
  const base = await scratch.buildBase(repoFiles);
  const c7Input = c7InputFrom(bundleJson);
  const c7Seed = pickOrderSeed(api.seededShuffle, c7Input);
  expect(c7Seed).not.toBeNull();
  const assertions = (bundleJson.assertions as { id: string }[]).map((a) =>
    a.id === "c7" ? { ...a, seed: c7Seed } : a,
  );
  const bundle = HoldoutBundleSchema.parse({ ...bundleJson, assertions, repo_files: repoFiles });
  const deps = fakeDeps(zodCacheDir());
  return {
    api,
    ctl,
    scratch,
    base,
    bundle,
    repoFiles,
    deps,
    ref: { family_id: bundle.family_id, variant_id: bundle.variant_id },
    c7Input,
    c7Seed: c7Seed!,
  };
}

interface Run {
  records: ProbeRecord[];
  spawn: SpawnFn;
  controls: ControlCacheLike;
  sandbox: SandboxKind;
  timeoutMs: number;
}

function mkRun(
  s: Setup,
  opts: { sandbox?: SandboxKind; timeoutMs?: number; compare?: CompareFn } = {},
): Run {
  const records: ProbeRecord[] = [];
  const spawn = recordingSpawn(records);
  const controls = new s.ctl.ControlCache({
    scratch: s.scratch,
    sandbox: opts.sandbox ?? "none",
    deps: s.deps,
    buildId,
    spawn,
    timeoutMs: opts.timeoutMs ?? 10_000,
    ...(opts.compare === undefined ? {} : { compare: opts.compare }),
  });
  return {
    records,
    spawn,
    controls,
    sandbox: opts.sandbox ?? "none",
    timeoutMs: opts.timeoutMs ?? 10_000,
  };
}

function gradeCtx(s: Setup, run: Run, overrides: Partial<GradeCtx> = {}): GradeCtx {
  return {
    bundle: s.bundle,
    scratch: s.scratch,
    controls: run.controls,
    deps: s.deps,
    sandbox: run.sandbox,
    spawn: run.spawn,
    timeoutMs: run.timeoutMs,
    ...overrides,
  };
}

function gradeInput(s: Setup, finalSha: string, overrides: Partial<GradeInput> = {}): GradeInput {
  return { fixture_ref: s.ref, base_sha: s.base, final_sha: finalSha, ...overrides };
}

async function grade(
  s: Setup,
  run: Run,
  sha: string,
  opts: { input?: Partial<GradeInput>; ctx?: Partial<GradeCtx> } = {},
): Promise<unknown> {
  return await s.api.grade(gradeInput(s, sha, opts.input), gradeCtx(s, run, opts.ctx));
}

async function goodSha(s: Setup): Promise<string> {
  return await s.scratch.applyPatch(s.base, s.bundle.patches.good);
}

async function badSha(s: Setup): Promise<string> {
  return await s.scratch.applyPatch(s.base, s.bundle.patches.bad[0]!);
}

// --- cases -------------------------------------------------------------------

test("a good candidate earns a signed passing hidden_assertion receipt", async () => {
  const s = await setup();
  const final = await goodSha(s);
  const fixtureJson = readJson("fixture.json");
  const publicFixture = FixturePublicSchema.safeParse({
    ...fixtureJson,
    base_sha: s.base,
    task_digest: taskDigest(TASK),
    hidden_ref: { assertion_set_digest: assertionSetDigest(s.bundle) },
    content_digest: bundleContentDigest(s.bundle),
  });
  expect(publicFixture.success).toBe(true);
  const bundleJson = readJson("bundle.json");
  expect(HoldoutBundleSchema.safeParse({ ...bundleJson, repo_files: s.repoFiles }).success).toBe(
    true,
  );
  for (const patch of [s.bundle.patches.good, ...s.bundle.patches.bad, ...s.bundle.mutants]) {
    expect(await s.scratch.applyPatch(s.base, patch)).toMatch(SHA40);
  }

  const run = mkRun(s);
  const receipt = parseReceipt(await grade(s, run, final));

  expect(receipt.kind).toBe("hidden_assertion");
  expect(receipt.producer).toBe("grader");
  expect(receipt.claimed_verdict).toBe("pass");
  expect(receipt.fail_reason).toBeNull();
  expect(receipt.sha).toBe(final);
  expect(receipt.control_verdict).toBe("pass");
  expect(receipt.per_check).toEqual(ALL_IDS.map((id) => ({ id, ok: true })));
  expect(receipt.assertion_set_digest).toBe(assertionSetDigest(s.bundle));
  expect(receipt.grader_build).toBe(buildId);
  expect(receipt.receipt_digest).toBe(receiptDigest(receipt));
  expect("verdict" in receipt).toBe(false);
}, 120_000);

test("the bad patch still passes visible tests but fails hidden c3", async () => {
  const s = await setup();
  const sha = await badSha(s);
  const outDir = join(mkTmp("penumbra-grade-vis-"), "tree");
  const mat = await materialize({
    repo: s.scratch.repoDir,
    sha,
    outDir,
    gitEnv: s.scratch.gitEnv,
  });
  expect(mat.ok).toBe(true);
  const visible = spawnSync(process.execPath, ["test"], { cwd: outDir });
  expect(visible.status).toBe(0);

  const run = mkRun(s);
  const receipt = parseReceipt(await grade(s, run, sha));

  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
  expect(receipt.sha).toBe(sha);
  expectChecks(receipt, { c3: false });
  expectAllOk(receipt, ["c1", "c2", "c4", "c5", "c6", "c7"]);
}, 120_000);

test("zod-importing candidates resolve deps through the provider", async () => {
  const s = await setup();
  const zodGood = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": ZOD_GOOD_TS,
  });
  const zodBad = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": ZOD_BAD_TS,
  });
  const run = mkRun(s);

  const ensured = await run.controls.ensure(s.ref, s.bundle);
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) {
    throw new Error("unreachable");
  }
  expect(ensured.control.verdict).toBe("pass");

  const pass = parseReceipt(await grade(s, run, zodGood));
  expect(pass.claimed_verdict).toBe("pass");
  const fail = parseReceipt(await grade(s, run, zodBad));
  expect(fail.claimed_verdict).toBe("fail");
  expect(fail.fail_reason).toBe("hidden_failed");
}, 120_000);

test("a candidate bunfig preload and its side effects are never honored", async () => {
  const s = await setup();
  const evilBad = await commitFiles(s.scratch, await badSha(s), {
    "bunfig.toml": BUNFIG_TOML,
    "evil.ts": EVIL_LOG_TS,
  });
  const evilGood = await commitFiles(s.scratch, await goodSha(s), {
    "bunfig.toml": BUNFIG_TOML,
    "evil.ts": EVIL_THROW_TS,
  });
  const run = mkRun(s);

  const bad = parseReceipt(await grade(s, run, evilBad));
  expect(bad.claimed_verdict).toBe("fail");
  expect(bad.fail_reason).toBe("hidden_failed");
  const good = parseReceipt(await grade(s, run, evilGood));
  expect(good.claimed_verdict).toBe("pass");
}, 120_000);

test("a RESULT file and RESULT:PASS output on stdio cannot forge a pass", async () => {
  const s = await setup();
  const candSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": BAD_LOG_TS,
    RESULT: "RESULT: PASS\n",
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, candSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
}, 120_000);

test("a candidate that spins at import fails candidate_timeout, not unknown", async () => {
  const s = await setup();
  const spinSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": SPIN_TS,
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, spinSha, { ctx: { timeoutMs: 3_000 } }));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("candidate_timeout");
}, 120_000);

test("a control that spins at import makes every candidate ungradeable", async () => {
  const s = await setup();
  const spinSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": SPIN_TS,
  });
  const spinBundle: HoldoutBundle = {
    ...s.bundle,
    variant_id: "spin",
    patches: { good: await patchBetween(s.scratch, s.base, spinSha), bad: s.bundle.patches.bad },
  };
  const run = mkRun(s, { timeoutMs: 2_000 });

  const res = await grade(s, run, await goodSha(s), {
    input: { fixture_ref: { family_id: s.bundle.family_id, variant_id: "spin" } },
    ctx: { bundle: spinBundle },
  });

  expect(res).toEqual({ ungradeable: "grader_control_failed" });
  expect(countCls(run.records, "candidate")).toBe(0);
  expect(
    readdirSync(join(s.scratch.dir, "trees")).filter((name) => name.startsWith("cand-")),
  ).toEqual([]);
}, 120_000);

test("a commit that does not descend from base fails base_not_ancestor", async () => {
  const s = await setup();
  const rootSha = await commitFiles(s.scratch, null, {
    ...s.repoFiles,
    "src/validate.ts": GOOD_VALIDATE_TS,
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, rootSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("base_not_ancestor");
  expect(receipt.sha).toBe(rootSha);
  expect(countCls(run.records, "candidate")).toBe(0);

  const missing = await grade(s, run, await goodSha(s), {
    input: { base_sha: "f".repeat(40) },
  });
  expect(missing).toEqual({ ungradeable: "base_missing" });
}, 120_000);

test("self-qualification rejects a grader that cannot tell good from bad", async () => {
  const s = await setup();
  const run = mkRun(s);
  const qualify = (
    bundle: HoldoutBundle,
    ref: FixtureRef,
    compare?: CompareFn,
  ): Promise<SelfQualifyOutcome> =>
    s.ctl.selfQualify(ref, {
      bundle,
      scratch: s.scratch,
      baseSha: s.base,
      sandbox: "none",
      deps: s.deps,
      buildId,
      spawn: run.spawn,
      timeoutMs: 10_000,
      control: controlResult,
      ...(compare === undefined ? {} : { compare }),
    });
  const controlResult = await s.ctl.qualifyControl(s.ref, {
    bundle: s.bundle,
    scratch: s.scratch,
    baseSha: s.base,
    sandbox: "none",
    deps: s.deps,
    buildId,
    spawn: run.spawn,
    timeoutMs: 10_000,
  });
  expect(controlResult.verdict).toBe("pass");

  const permissiveRef = { family_id: s.bundle.family_id, variant_id: "permissive" };
  const permissiveBundle: HoldoutBundle = {
    ...s.bundle,
    variant_id: "permissive",
    mutants: [s.bundle.patches.good, ...s.bundle.mutants],
  };

  expect(await qualify(s.bundle, s.ref, () => true)).toEqual({
    ok: false,
    reason: "grader_permissive",
  });
  expect(await qualify(s.bundle, s.ref)).toEqual({ ok: true });
  expect(await qualify({ ...s.bundle, assertions: [] }, s.ref)).toEqual({
    ok: false,
    reason: "grader_permissive",
  });
  expect(await qualify(permissiveBundle, permissiveRef)).toEqual({
    ok: false,
    reason: "grader_permissive",
  });

  const permRun = mkRun(s, { compare: () => true });
  const res = await grade(s, permRun, await goodSha(s));
  expect(res).toEqual({ ungradeable: "grader_control_failed" });
}, 120_000);

test("file assertions inspect commit blobs, not the materialized tree", async () => {
  const s = await setup();
  const variantSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "package.json": PKG_WITH_BUN,
    "src/validate.ts": GOOD_VALIDATE_TS,
  });
  const filesBundle: HoldoutBundle = {
    ...s.bundle,
    variant_id: "files",
    assertions: [
      ...s.bundle.assertions,
      { kind: "file_absent", id: "c10", path: ".env" },
      { kind: "file_matches", id: "c11", path: "package.json", pattern: '"bun"\\s*:' },
    ],
    patches: {
      good: await patchBetween(s.scratch, s.base, variantSha),
      bad: s.bundle.patches.bad,
    },
  };
  const filesRef = { family_id: s.bundle.family_id, variant_id: "files" };
  const run = mkRun(s);

  const candSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    ".env": ENV_FILE,
    "package.json": PKG_WITH_BUN,
    "src/validate.ts": GOOD_VALIDATE_TS,
  });
  const receipt = parseReceipt(
    await grade(s, run, candSha, {
      input: { fixture_ref: filesRef },
      ctx: { bundle: filesBundle },
    }),
  );
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
  expect(receipt.assertion_set_digest).toBe(assertionSetDigest(filesBundle));
  expectChecks(receipt, { c10: false, c11: true });
  expectAllOk(receipt, ALL_IDS);

  const linkSha = await commitFiles(
    s.scratch,
    s.base,
    Object.fromEntries(Object.entries(s.repoFiles).filter(([p]) => p !== "src/validate.ts")),
    { symlinks: { "src/validate.ts": "evil-target.ts" } },
  );
  const candBefore = countCls(run.records, "candidate");
  const linkReceipt = parseReceipt(
    await grade(s, run, linkSha, {
      input: { fixture_ref: filesRef },
      ctx: { bundle: filesBundle },
    }),
  );
  expect(linkReceipt.claimed_verdict).toBe("fail");
  expect(linkReceipt.fail_reason).toBe("contract_violation");
  expect(countCls(run.records, "candidate")).toBe(candBefore);
}, 120_000);

test("grade.ts bundles the canonical digest machinery with control and evaluate", async () => {
  const bundle = await runGraderBundle([join(import.meta.dir, "grade.ts")]);
  expect(bundle.ok).toBe(true);
  expect(bundle.text).toContain("CanonicalJsonError");
  for (const suffix of ["core/src/evals/canonical.ts", "grader/control.ts", "grader/evaluate.ts"]) {
    expect(bundle.inputs.some((key) => key.endsWith(suffix))).toBe(true);
  }
  expect(await graderBuildId()).toMatch(BUILD_ID);
}, 120_000);

test("control and self-qualification legs run before any candidate leg", async () => {
  const s = await setup();
  const run = mkRun(s);
  await grade(s, run, await goodSha(s));

  const classes = run.records.map(clsOf);
  const firstCand = classes.indexOf("candidate");
  expect(firstCand).toBeGreaterThanOrEqual(0);
  expect(classes).toContain("control");
  expect(classes).toContain("selfq");
  for (const [i, cls] of classes.entries()) {
    if (cls === "control" || cls === "selfq") {
      expect(i).toBeLessThan(firstCand);
    }
  }
}, 120_000);

test("control qualification is computed once per family/variant@build", async () => {
  const s = await setup();
  const run = mkRun(s);

  const pass = parseReceipt(await grade(s, run, await goodSha(s)));
  expect(pass.claimed_verdict).toBe("pass");
  const controls = countControlSelfq(run.records);
  expect(controls).toBeGreaterThanOrEqual(2);

  const fail = parseReceipt(await grade(s, run, await badSha(s)));
  expect(fail.claimed_verdict).toBe("fail");
  expect(fail.fail_reason).toBe("hidden_failed");
  expect(countControlSelfq(run.records)).toBe(controls);
}, 120_000);

test("control keys fold in the comparator identity", async () => {
  const ctl = await loadControl();
  const ref: FixtureRef = { family_id: "fam-x", variant_id: "v1" };
  const cmpA: CompareFn = (observed) => observed !== null;
  const cmpB: CompareFn = () => true;

  expect(ctl.controlKey(ref, "b1")).toBe(ctl.controlKey(ref, "b1", "default"));
  expect(ctl.controlKey(ref, "b1")).not.toBe(ctl.controlKey(ref, "b1", "cmp-a"));
  expect(ctl.controlKey(ref, "b1", "cmp-a")).not.toBe(ctl.controlKey(ref, "b1", "cmp-b"));
  expect(ctl.comparatorIdentity(undefined)).toBe("default");
  expect(ctl.comparatorIdentity(cmpA)).toBe(ctl.comparatorIdentity(cmpA));
  expect(ctl.comparatorIdentity(cmpA)).not.toBe(ctl.comparatorIdentity(cmpB));
  expect(ctl.comparatorIdentity(cmpA, "named")).toBe("named");
});

test("control qualification is not shared across comparators", async () => {
  const s = await setup();
  // Assertion-free bundle: ensure() qualifies without spawning any leg, so a
  // key collision would be visible purely in the returned cache keys.
  const emptyBundle: HoldoutBundle = { ...s.bundle, assertions: [] };

  const runDefault = mkRun(s);
  const runAlt = mkRun(s, { compare: stripSentinelCompare });

  const first = await runDefault.controls.ensure(s.ref, emptyBundle);
  const again = await runDefault.controls.ensure(s.ref, emptyBundle);
  const alt = await runAlt.controls.ensure(s.ref, emptyBundle);

  expect(first.key).toBe(again.key);
  expect(first.key).not.toBe(alt.key);
}, 120_000);

test("a deterministic invariant runs the same call in two fresh processes", async () => {
  const s = await setup();
  const candSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": MEMO_TS,
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, candSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
  expectChecks(receipt, { c6: false });
  expectAllOk(receipt, ["c1", "c2", "c3", "c4", "c5"]);

  const c6Records = run.records.filter((rec) => {
    const calls = payloadOf(rec)?.calls ?? [];
    return clsOf(rec) === "candidate" && calls.length === 1 && calls[0]?.id === "c6";
  });
  expect(c6Records).toHaveLength(2);
}, 120_000);

test("an order-insensitive invariant compares x with the parent-side shuffle", async () => {
  const s = await setup();
  const x = s.c7Input;
  const xSnapshot = JSON.parse(JSON.stringify(x)) as unknown[];
  const shuffled = s.api.seededShuffle(x, s.c7Seed);

  expect(s.api.seededShuffle(x, s.c7Seed)).toEqual(shuffled);
  expect(x).toEqual(xSnapshot);
  const keyOf = (v: unknown): string => JSON.stringify(v);
  expect([...shuffled].map(keyOf).sort()).toEqual([...x].map(keyOf).sort());
  expect(deepEqual(shuffled[0], x[0])).toBe(false);

  const candSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": ORDER_TS,
  });
  const run = mkRun(s);
  const receipt = parseReceipt(await grade(s, run, candSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
  expectChecks(receipt, { c7: false });

  const c7Inputs = callsWithId(run.records, "candidate", "c7");
  expect(c7Inputs).toHaveLength(2);
  expect(c7Inputs.filter((input) => deepEqual(input, x))).toHaveLength(1);
  expect(c7Inputs.filter((input) => deepEqual(input, shuffled))).toHaveLength(1);
}, 120_000);

test("an idempotent invariant re-applies the first output in a fresh process", async () => {
  const s = await setup();
  const c8 = s.bundle.assertions.find((a) => a.id === "c8");
  if (c8?.kind !== "invariant" || c8.property !== "idempotent") {
    throw new Error("unreachable: c8 must be an idempotent invariant");
  }
  expect(c8.export).toBe("dedupe");
  const firstInput: unknown = c8.inputs[0];
  if (!Array.isArray(firstInput)) {
    throw new Error("unreachable: c8 input must be an array");
  }
  const seenKeys = new Set<string>();
  const dedupedFixtureInput = firstInput.filter((item) => {
    const key = JSON.stringify(item);
    if (seenKeys.has(key)) {
      return false;
    }
    seenKeys.add(key);
    return true;
  });

  const run = mkRun(s);
  const receipt = parseReceipt(await grade(s, run, await goodSha(s)));
  expect(receipt.claimed_verdict).toBe("pass");
  expectChecks(receipt, { c8: true });

  const c8Records = run.records.filter((rec) => {
    const calls = payloadOf(rec)?.calls ?? [];
    return clsOf(rec) === "candidate" && calls.length === 1 && calls[0]?.id === "c8";
  });
  expect(c8Records).toHaveLength(2);
  const inputs = c8Records.map((rec) => payloadOf(rec)?.calls[0]?.input);
  expect(deepEqual(inputs[0], c8.inputs[0])).toBe(true);
  expect(deepEqual(inputs[1], dedupedFixtureInput)).toBe(true);
}, 120_000);

test("an idempotent invariant fails when the first call has no output", async () => {
  const s = await setup();
  const throwSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": THROWING_DEDUPE_TS,
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, throwSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
  expectChecks(receipt, { c8: false });
  expectAllOk(receipt, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);

  // A missing first output short-circuits: no re-application leg runs on it.
  const c8Records = run.records.filter((rec) => {
    const calls = payloadOf(rec)?.calls ?? [];
    return clsOf(rec) === "candidate" && calls.length === 1 && calls[0]?.id === "c8";
  });
  expect(c8Records).toHaveLength(1);
}, 120_000);

test("the non-idempotent dedupe mutant fails only the idempotent invariant", async () => {
  const s = await setup();
  const sha = await s.scratch.applyPatch(s.base, s.bundle.mutants[2]!);
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, sha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("hidden_failed");
  expectChecks(receipt, { c8: false });
  expectAllOk(receipt, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
}, 120_000);

test("a candidate forging the fd-3 probe frame gets contract_violation", async () => {
  const s = await setup();
  const forgeSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": FORGE_PROBE_TS,
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, forgeSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("contract_violation");

  // The tamper must abort on the probe leg itself: the probe call ran, but no
  // invariant leg (c6/c7/c8) may run afterwards. Without the probe-path
  // tamper mapping this candidate would grade evaluated/hidden_failed and
  // invariant legs would appear here.
  const candidateCallIds = new Set(
    run.records
      .filter((rec) => clsOf(rec) === "candidate")
      .flatMap((rec) => payloadOf(rec)?.calls.map((call) => call.id) ?? []),
  );
  expect(candidateCallIds.has("c1")).toBe(true);
  expect(candidateCallIds.has("c6")).toBe(false);
  expect(candidateCallIds.has("c7")).toBe(false);
  expect(candidateCallIds.has("c8")).toBe(false);
}, 120_000);

test("forgery during an invariant call is contract_violation, not a failed check", async () => {
  const s = await setup();
  const forgeSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": FORGE_INVARIANT_TS,
  });
  const run = mkRun(s);

  const receipt = parseReceipt(await grade(s, run, forgeSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("contract_violation");
}, 120_000);

test("a spin inside the invariant export times out as candidate_timeout", async () => {
  const s = await setup();
  const spinSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": SPIN_SUMMARIZE_TS,
  });
  const run = mkRun(s, { timeoutMs: 3_000 });

  const receipt = parseReceipt(await grade(s, run, spinSha));
  expect(receipt.claimed_verdict).toBe("fail");
  expect(receipt.fail_reason).toBe("candidate_timeout");
}, 120_000);

test("grade evaluates the candidate with the control cache's comparator", async () => {
  const s = await setup();
  const sentinelSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": SENTINEL_TS,
  });

  const strict = mkRun(s);
  const strictReceipt = parseReceipt(await grade(s, strict, sentinelSha));
  expect(strictReceipt.claimed_verdict).toBe("fail");
  expect(strictReceipt.fail_reason).toBe("hidden_failed");
  expectChecks(strictReceipt, { c1: false });

  const lenient = mkRun(s, { compare: stripSentinelCompare });
  const lenientReceipt = parseReceipt(await grade(s, lenient, sentinelSha));
  expect(lenientReceipt.claimed_verdict).toBe("pass");
  expectChecks(lenientReceipt, { c1: true });
}, 120_000);

async function legIsolationCase(sandbox: SandboxKind): Promise<void> {
  const s = await setup();
  const run = mkRun(s, { sandbox, timeoutMs: 3_000 });

  const ensured = await run.controls.ensure(s.ref, s.bundle);
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) {
    throw new Error("unreachable");
  }
  expect(ensured.control.verdict).toBe("pass");
  const controls = countControlSelfq(run.records);

  const markA = run.records.length;
  const aSha = await commitFiles(s.scratch, s.base, {
    ...s.repoFiles,
    "src/validate.ts": POISON_TS,
  });
  const recA = parseReceipt(await grade(s, run, aSha));
  expect(recA.claimed_verdict).toBe("fail");
  expect(recA.fail_reason).toBe("candidate_timeout");

  const markB = run.records.length;
  const recB = parseReceipt(await grade(s, run, await goodSha(s)));
  expect(recB.claimed_verdict).toBe("pass");
  expect(countControlSelfq(run.records)).toBe(controls);

  const legsRoot = join(realpathSync(s.scratch.dir), "legs");
  const roots = run.records.map(legRootOf);
  for (const root of roots) {
    expect(root.startsWith(`${legsRoot}/`)).toBe(true);
  }
  expect(new Set(roots).size).toBe(roots.length);

  const treeSet = (recs: ProbeRecord[]): Set<string> =>
    new Set(recs.map((rec) => payloadOf(rec)?.tree).filter((t): t is string => t !== undefined));
  const controlTrees = treeSet(
    run.records.filter((rec) => clsOf(rec) === "control" || clsOf(rec) === "selfq"),
  );
  const treesA = treeSet(run.records.slice(markA, markB));
  const treesB = treeSet(run.records.slice(markB));
  for (const tree of treesA) {
    expect(treesB.has(tree)).toBe(false);
    expect(controlTrees.has(tree)).toBe(false);
  }
  for (const tree of treesB) {
    expect(controlTrees.has(tree)).toBe(false);
  }
  expect(findNamed(s.scratch.dir, "poison")).toEqual([]);
}

test("each probe leg gets an isolated leg HOME that is removed afterwards", async () => {
  await legIsolationCase("none");
}, 120_000);

test.skipIf(HOST_SANDBOX_KIND === "none")(
  "[sbx] each probe leg gets an isolated leg HOME that is removed afterwards",
  async () => {
    await legIsolationCase(HOST_SANDBOX_KIND);
  },
  120_000,
);
