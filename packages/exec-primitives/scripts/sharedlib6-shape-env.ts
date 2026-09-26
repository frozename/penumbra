/**
 * sharedlib6-shape-env.ts — SHAPE bindings for the evidence records the
 * regeneration diff does not compare field for field, each tied to this
 * check's own run:
 *   - toolchain: exactly { bun, node, typescript }, equal to this check's
 *     `bun --version`, `node --version` and `tsc --version`;
 *   - poison_layer: distinct @penumbra/* names, a superset of the guard stubs
 *     this run wrote (a fresh install links fewer workspace packages than a
 *     long-lived one), @penumbra/core included, each a workspace package;
 *   - artifact_sha256: exactly the run files the writer hashes, each a
 *     sha256 hex digest, each file this run has written by SHAPE time present;
 *   - generated_at: an ISO-8601 UTC timestamp between the head_sha commit
 *     and now.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ARTIFACT_FILES,
  CHECK_VERDICT_FILE,
  readJsonFile,
  rec,
  type ShapeContext,
  str,
} from "./sharedlib6-shape-util.js";

type Ev = Record<string, unknown>;

export interface Toolchain {
  bun: string;
  node: string;
  typescript: string;
}

const TOOLCHAIN_KEYS = ["bun", "node", "typescript"];
const PACKAGE_NAME_RE = /^@penumbra\/[a-z0-9][a-z0-9._-]*$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function versionOf(argv: string[], cwd: string): string {
  const [bin, ...args] = argv;
  if (bin === undefined) return "";
  const r = spawnSync(bin, args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().replace(/^Version\s+/, "") : "";
}

const toolchainCache = new Map<string, Toolchain>();

/** The toolchain this check runs; the evidence writer records the same. */
export function measureToolchain(repoRoot: string): Toolchain {
  const hit = toolchainCache.get(repoRoot);
  if (hit !== undefined) return hit;
  const measured = {
    bun: versionOf(["bun", "--version"], repoRoot),
    node: versionOf(["node", "--version"], repoRoot),
    typescript: versionOf(["bunx", "tsc", "--version"], repoRoot),
  };
  toolchainCache.set(repoRoot, measured);
  return measured;
}

function short(v: unknown): string {
  const text = v === undefined ? "undefined" : JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function toolchainReasons(ctx: ShapeContext, evidence: Ev): string[] {
  const got = rec(evidence["toolchain"]);
  if (got === undefined) return ["toolchain missing"];
  const reasons: string[] = [];
  const keys = Object.keys(got).sort();
  if (keys.join(",") !== TOOLCHAIN_KEYS.join(",")) {
    reasons.push(`toolchain keys [${keys.join(",")}] != [${TOOLCHAIN_KEYS.join(",")}]`);
  }
  const want = measureToolchain(ctx.repoRoot);
  for (const k of TOOLCHAIN_KEYS) {
    const measured = want[k as keyof Toolchain];
    if (measured === "") reasons.push(`toolchain.${k}: this check could not measure ${k}`);
    else if (got[k] !== measured) {
      reasons.push(`toolchain.${k} ${short(got[k])} != this check's ${k} version "${measured}"`);
    }
  }
  return reasons;
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory());
}

const workspaceCache = new Map<string, Set<string>>();

/** Package names under the root manifest's workspace globs (`dir/*` or a dir). */
function workspacePackageNames(repoRoot: string): Set<string> {
  const hit = workspaceCache.get(repoRoot);
  if (hit !== undefined) return hit;
  const names = new Set<string>();
  const globs = rec(readJsonFile(join(repoRoot, "package.json")))?.["workspaces"];
  for (const glob of Array.isArray(globs) ? globs.map(str) : []) {
    const dirs = glob.endsWith("/*")
      ? subdirs(join(repoRoot, glob.slice(0, -2)))
      : [join(repoRoot, glob)];
    for (const dir of dirs) {
      const name = str(rec(readJsonFile(join(dir, "package.json")))?.["name"]);
      if (name !== "") names.add(name);
    }
  }
  workspaceCache.set(repoRoot, names);
  return names;
}

function poisonLayerReasons(ctx: ShapeContext, evidence: Ev, measured: Ev): string[] {
  const got = evidence["poison_layer"];
  if (!Array.isArray(got) || got.length === 0 || got.some((n) => typeof n !== "string")) {
    return ["poison_layer must be a non-empty list of package names"];
  }
  const names = got as string[];
  const reasons: string[] = [];
  if (new Set(names).size !== names.length) reasons.push("poison_layer repeats a name");
  const runLayer = Array.isArray(measured["poison_layer"])
    ? (measured["poison_layer"] as unknown[]).map(str)
    : [];
  if (runLayer.length === 0) reasons.push("poison_layer: this run recorded no guard stubs");
  const missing = runLayer.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    reasons.push(`poison_layer lacks this run's guard stub(s) ${missing.join(", ")}`);
  }
  if (!names.includes("@penumbra/core")) {
    reasons.push("poison_layer lacks @penumbra/core, the package the guard probe imports");
  }
  const workspace = workspacePackageNames(ctx.repoRoot);
  const foreign = names.filter((n) => !PACKAGE_NAME_RE.test(n) || !workspace.has(n));
  if (foreign.length > 0) {
    reasons.push(`poison_layer names non-workspace package(s) ${foreign.join(", ")}`);
  }
  return reasons;
}

function artifactShaReasons(ctx: ShapeContext, evidence: Ev): string[] {
  const got = rec(evidence["artifact_sha256"]);
  if (got === undefined) return ["artifact_sha256 missing"];
  const reasons: string[] = [];
  const keys = Object.keys(got).sort();
  const want = [...ARTIFACT_FILES].sort();
  if (keys.join(",") !== want.join(",")) {
    reasons.push(
      `artifact_sha256 keys [${keys.join(",")}] != the files the writer hashes [${want.join(",")}]`,
    );
  }
  for (const [k, v] of Object.entries(got)) {
    if (!/^[0-9a-f]{64}$/.test(str(v))) {
      reasons.push(`artifact_sha256.${k} ${short(v)} is not a sha256 hex digest`);
    }
  }
  for (const f of ARTIFACT_FILES) {
    if (f !== CHECK_VERDICT_FILE && !existsSync(join(ctx.runDir, f))) {
      reasons.push(`artifact_sha256.${f}: this run wrote no ${f}`);
    }
  }
  return reasons;
}

const commitTimeCache = new Map<string, number>();

function commitTime(ctx: ShapeContext, sha: string): number {
  const hit = commitTimeCache.get(sha);
  if (hit !== undefined) return hit;
  const r = ctx.git(["show", "-s", "--format=%cI", sha]);
  const t = r.exit === 0 ? Date.parse(r.output.trim()) : Number.NaN;
  commitTimeCache.set(sha, t);
  return t;
}

function generatedAtReasons(ctx: ShapeContext, evidence: Ev): string[] {
  const g = str(evidence["generated_at"]);
  const t = Date.parse(g);
  if (!ISO_UTC_RE.test(g) || Number.isNaN(t)) {
    return [`generated_at ${short(evidence["generated_at"])} is not an ISO-8601 UTC timestamp`];
  }
  if (t > Date.now()) return [`generated_at ${g} is in the future`];
  const head = str(evidence["head_sha"]);
  const headTime = head === "" ? Number.NaN : commitTime(ctx, head);
  if (!Number.isNaN(headTime) && t < headTime) {
    return [`generated_at ${g} precedes the head_sha commit it was written against`];
  }
  return [];
}

/** Every environment binding over one evidence object. */
export function shapeEnvironment(ctx: ShapeContext, evidence: Ev, measured: Ev): string[] {
  return [
    ...toolchainReasons(ctx, evidence),
    ...poisonLayerReasons(ctx, evidence, measured),
    ...artifactShaReasons(ctx, evidence),
    ...generatedAtReasons(ctx, evidence),
  ];
}
