import { canonicalJson, sha256Hex } from "@penumbra/core/evals/canonical";
import {
  assertionSetDigest,
  bundleContentDigest,
  type HoldoutBundle,
  HoldoutBundleSchema,
  type HoldoutLock,
  type HoldoutLockEntry,
} from "@penumbra/core/evals/fixture";
import { unsealHoldout, verifyHoldoutLock } from "@penumbra/core/evals/holdout";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { defaultRunCommand, type RunCommand } from "./materialize.js";

export type HoldoutStoreErrorCode =
  | "store_path_not_absolute"
  | "store_in_repo"
  | "unseal_incomplete"
  | "lock_digest_mismatch"
  | "plan_sha_mismatch"
  | "plan_untracked"
  | "access_log_corrupt"
  | "entry_not_in_lock"
  | "unseal_required"
  | "bundle_missing"
  | "content_digest_mismatch"
  | "assertion_set_digest_mismatch"
  | "bundle_invalid";

export class HoldoutStoreError extends Error {
  readonly code: HoldoutStoreErrorCode;

  constructor(code: HoldoutStoreErrorCode, message: string) {
    super(message);
    this.name = "HoldoutStoreError";
    this.code = code;
  }
}

export class UnsealExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsealExhausted";
  }
}

export interface HoldoutStore {
  readonly path: string;
  readonly sessionId: string | null;
  readEntry(entry: HoldoutLockEntry): Promise<HoldoutBundle>;
}

export interface OpenHoldoutStoreOptions {
  storePath: string;
  lock: HoldoutLock;
  unseal?: UnsealGrant;
  grant?: UnsealGrant;
  planPath?: string;
  repoRoot?: string;
  runCommand?: RunCommand;
}

export interface HoldoutStoreMismatch {
  family_id: string;
  variant_id: string;
  which: "missing" | "content" | "assertion_set";
}

export interface HoldoutStoreVerifyResult {
  ok: boolean;
  mismatches: HoldoutStoreMismatch[];
}

type UnsealGrant = ReturnType<typeof unsealHoldout>;
type BundleFailure = "missing" | "content" | "assertion_set" | "invalid";
type BundleCheck = { status: "ok"; bundle: HoldoutBundle } | { status: BundleFailure };

const ACCESS_LOG = "access.jsonl";

function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return env;
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

async function assertOutsideWorkTree(
  run: RunCommand,
  probeDir: string,
  target: string,
): Promise<void> {
  const res = await run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: probeDir,
    env: scrubbedGitEnv(),
  });
  if (res.stdout.toString("utf8").trim() === "true") {
    throw new HoldoutStoreError(
      "store_in_repo",
      `holdout store path ${target} is inside a git work tree`,
    );
  }
}

async function assertPlanTracked(
  run: RunCommand,
  repoRoot: string,
  planPath: string,
): Promise<void> {
  const res = await run("git", ["ls-files", "--error-unmatch", "--", planPath], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
  });
  if (res.code !== 0) {
    throw new HoldoutStoreError(
      "plan_untracked",
      `analysis plan ${planPath} is not tracked by git in ${repoRoot}`,
    );
  }
}

function parseAccessLine(line: string, accessPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HoldoutStoreError("access_log_corrupt", `malformed line in ${accessPath}`);
  }
}

function readAccessLog(accessPath: string): Record<string, unknown>[] {
  if (!existsSync(accessPath)) {
    return [];
  }
  return readFileSync(accessPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseAccessLine(line, accessPath));
}

function appendAccessRecord(accessPath: string, record: Record<string, unknown>): void {
  appendFileSync(accessPath, `${JSON.stringify(record)}\n`, "utf8");
}

function bundlePathOf(storePath: string, entry: HoldoutLockEntry): string {
  return join(storePath, entry.content_digest, "bundle.json");
}

function bundleMatchesEntry(bundle: HoldoutBundle, entry: HoldoutLockEntry): boolean {
  return bundle.family_id === entry.family_id && bundle.variant_id === entry.variant_id;
}

async function inspectBundle(storePath: string, entry: HoldoutLockEntry): Promise<BundleCheck> {
  const bundlePath = bundlePathOf(storePath, entry);
  let text: string;
  try {
    text = await readFile(bundlePath, "utf8");
  } catch {
    return { status: "missing" };
  }
  const raw: unknown = JSON.parse(text);
  if (bundleContentDigest(raw as object) !== entry.content_digest) {
    return { status: "content" };
  }
  const parsed = HoldoutBundleSchema.safeParse(raw);
  if (!parsed.success || !bundleMatchesEntry(parsed.data, entry)) {
    return { status: "invalid" };
  }
  if (assertionSetDigest(parsed.data) !== entry.assertion_set_digest) {
    return { status: "assertion_set" };
  }
  return { status: "ok", bundle: parsed.data };
}

function entryIsLocked(entry: HoldoutLockEntry, lock: HoldoutLock): boolean {
  const needle = canonicalJson(entry);
  return lock.entries.some((lockEntry) => canonicalJson(lockEntry) === needle);
}

function failureToStoreError(failure: BundleFailure, entry: HoldoutLockEntry): HoldoutStoreError {
  const key = `${entry.family_id}/${entry.variant_id}`;
  if (failure === "missing") {
    return new HoldoutStoreError("bundle_missing", `bundle ${key} is missing from the store`);
  }
  if (failure === "content") {
    return new HoldoutStoreError(
      "content_digest_mismatch",
      `bundle ${key} does not match its lock content digest`,
    );
  }
  if (failure === "assertion_set") {
    return new HoldoutStoreError(
      "assertion_set_digest_mismatch",
      `bundle ${key} does not match its lock assertion set digest`,
    );
  }
  return new HoldoutStoreError("bundle_invalid", `bundle ${key} fails holdout bundle validation`);
}

function createStore(path: string, lock: HoldoutLock, sessionId: string | null): HoldoutStore {
  const cache = new Map<string, HoldoutBundle>();
  return {
    path,
    sessionId,
    async readEntry(entry: HoldoutLockEntry): Promise<HoldoutBundle> {
      if (!entryIsLocked(entry, lock)) {
        throw new HoldoutStoreError(
          "entry_not_in_lock",
          `entry ${entry.family_id}/${entry.variant_id} is not in the lock`,
        );
      }
      if (!entry.synthetic && sessionId === null) {
        throw new HoldoutStoreError(
          "unseal_required",
          `entry ${entry.family_id}/${entry.variant_id} requires an unsealed session`,
        );
      }
      const key = `${entry.family_id}/${entry.variant_id}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const check = await inspectBundle(path, entry);
      if (check.status !== "ok") {
        throw failureToStoreError(check.status, entry);
      }
      cache.set(key, check.bundle);
      return check.bundle;
    },
  };
}

function assertGrantMatchesPlan(unseal: UnsealGrant, lock: HoldoutLock, planPath: string): void {
  if (unseal.lock_digest !== lock.digest) {
    throw new HoldoutStoreError(
      "lock_digest_mismatch",
      "unseal grant lock digest does not match the lock",
    );
  }
  if (sha256Hex(readFileSync(planPath)) !== unseal.analysis_plan_sha256) {
    throw new HoldoutStoreError(
      "plan_sha_mismatch",
      `analysis plan ${planPath} does not match the grant sha256`,
    );
  }
}

function grantUnseal(unseal: UnsealGrant, accessPath: string): string {
  const grantedCount = readAccessLog(accessPath).filter(
    (record) => record["granted"] === true,
  ).length;
  if (grantedCount >= unseal.max_unseals) {
    appendAccessRecord(accessPath, {
      ts: new Date().toISOString(),
      plan_sha: unseal.analysis_plan_sha256,
      session_id: randomUUID(),
      granted: false,
    });
    throw new UnsealExhausted(
      `unseal budget of ${String(unseal.max_unseals)} exhausted for this analysis plan`,
    );
  }
  const sessionId = randomUUID();
  appendAccessRecord(accessPath, {
    ts: new Date().toISOString(),
    plan_sha: unseal.analysis_plan_sha256,
    session_id: sessionId,
    counter: grantedCount + 1,
    granted: true,
  });
  return sessionId;
}

async function resolveUnseal(
  options: OpenHoldoutStoreOptions,
  storePath: string,
  lock: HoldoutLock,
  run: RunCommand,
): Promise<string> {
  const unseal = options.unseal ?? options.grant;
  if (unseal === undefined) {
    throw new HoldoutStoreError("unseal_required", "no unseal grant provided");
  }
  if (options.planPath === undefined) {
    throw new HoldoutStoreError("unseal_incomplete", "unseal requires a planPath");
  }
  assertGrantMatchesPlan(unseal, lock, options.planPath);
  const repoRoot = options.repoRoot ?? dirname(options.planPath);
  await assertPlanTracked(run, repoRoot, options.planPath);
  return grantUnseal(unseal, join(storePath, ACCESS_LOG));
}

export async function openHoldoutStore(options: OpenHoldoutStoreOptions): Promise<HoldoutStore> {
  const { storePath } = options;
  if (!isAbsolute(storePath)) {
    throw new HoldoutStoreError(
      "store_path_not_absolute",
      `holdout store path must be absolute, got ${storePath}`,
    );
  }
  const lock = verifyHoldoutLock(options.lock);
  const run = options.runCommand ?? defaultRunCommand;
  await assertOutsideWorkTree(run, nearestExistingAncestor(storePath), storePath);
  mkdirSync(storePath, { recursive: true });
  if (options.unseal === undefined && options.grant === undefined) {
    return createStore(storePath, lock, null);
  }
  const sessionId = await resolveUnseal(options, storePath, lock, run);
  return createStore(storePath, lock, sessionId);
}

export async function verifyHoldoutStore(
  lock: HoldoutLock,
  storePath: string,
): Promise<HoldoutStoreVerifyResult> {
  const mismatches: HoldoutStoreMismatch[] = [];
  for (const entry of lock.entries) {
    const check = await inspectBundle(storePath, entry);
    if (check.status !== "ok") {
      const which = check.status === "invalid" ? "content" : check.status;
      mismatches.push({
        family_id: entry.family_id,
        variant_id: entry.variant_id,
        which,
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
