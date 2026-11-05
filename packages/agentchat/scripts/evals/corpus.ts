import type { FixturePublic, HoldoutBundle, HoldoutLock } from "@penumbra/core/evals/fixture";

import {
  assertionSetDigest,
  bundleContentDigest,
  FixturePublicSchema,
  HoldoutBundleSchema,
} from "@penumbra/core/evals/fixture";
import { assertHoldoutReservation } from "@penumbra/core/evals/holdout";
import { assertNoFamilyLeak } from "@penumbra/core/evals/split";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GraderScratch } from "./grader/scratch.js";

import { isSanitized } from "./sanitize.js";

export const DEFAULT_CORPUS_ROOT = fileURLToPath(
  new URL("../../test/fixtures/evals", import.meta.url),
);

const FIXTURE_FILE_NAMES = new Set(["fixture.json", "repo.files.json", "bundle.json"]);
const OS_JUNK_NAMES = new Set([".DS_Store"]);

export interface CorpusFixture {
  dir: string;
  fixture: FixturePublic;
  repoFiles: Record<string, string> | null;
  bundle: HoldoutBundle | null;
}

export class CorpusLintError extends Error {
  constructor(problems: readonly string[]) {
    super(`corpus lint failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "CorpusLintError";
  }
}

export interface LintCorpusOptions {
  scratch: GraderScratch;
  lock?: HoldoutLock | undefined;
}

function walkFiles(root: string, rel = ""): string[] {
  const dir = rel === "" ? root : join(root, rel);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, entryRel));
    } else {
      out.push(entryRel);
    }
  }
  return out;
}

function splitRel(rel: string): { parent: string; name: string } {
  const slash = rel.lastIndexOf("/");
  return slash === -1
    ? { parent: "", name: rel }
    : { parent: rel.slice(0, slash), name: rel.slice(slash + 1) };
}

function collectFormatProblems(files: readonly string[]): string[] {
  const problems: string[] = [];
  for (const rel of files) {
    const { name } = splitRel(rel);
    if (OS_JUNK_NAMES.has(name)) continue;
    if (!rel.endsWith(".json")) problems.push(`non_json_file ${rel}`);
  }
  return problems;
}

function collectSanitizedProblems(root: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  for (const rel of files) {
    const { name } = splitRel(rel);
    if (OS_JUNK_NAMES.has(name) || !rel.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, rel), "utf8")) as unknown;
    } catch {
      problems.push(`not_sanitized ${rel}`);
      continue;
    }
    if (!isSanitized(parsed)) problems.push(`not_sanitized ${rel}`);
  }
  return problems;
}

function seedFixtureDirs(files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const rel of files) {
    const { parent, name } = splitRel(rel);
    if (name === "fixture.json") out.add(parent);
  }
  return out;
}

function groupFixtureDirs(
  root: string,
  files: readonly string[],
  problems: string[],
): Map<string, Map<string, unknown>> {
  const dirs = new Map<string, Map<string, unknown>>();
  for (const parent of seedFixtureDirs(files)) {
    dirs.set(parent, new Map<string, unknown>());
  }
  for (const rel of files) {
    const { parent, name } = splitRel(rel);
    const dir = dirs.get(parent);
    if (dir === undefined) continue;
    if (OS_JUNK_NAMES.has(name)) continue;
    if (!FIXTURE_FILE_NAMES.has(name)) {
      problems.push(`unexpected_file ${rel}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, rel), "utf8")) as unknown;
    } catch {
      problems.push(`invalid_json ${rel}`);
      continue;
    }
    dir.set(name, parsed);
  }
  return dirs;
}

function composeBundle(
  dirFiles: Map<string, unknown>,
): { bundle: HoldoutBundle; repoFiles: Record<string, string> } | null {
  const bundleJson = dirFiles.get("bundle.json");
  const repoJson = dirFiles.get("repo.files.json");
  const isObj = (v: unknown): v is object => typeof v === "object" && v !== null;
  if (!isObj(bundleJson) || !isObj(repoJson)) return null;
  const parsed = HoldoutBundleSchema.safeParse({
    ...bundleJson,
    repo_files: repoJson,
  });
  if (!parsed.success) return null;
  return { bundle: parsed.data, repoFiles: repoJson as Record<string, string> };
}

function lintFixtureDir(
  dir: string,
  dirFiles: Map<string, unknown>,
  problems: string[],
): CorpusFixture | null {
  const parsed = FixturePublicSchema.safeParse(dirFiles.get("fixture.json"));
  if (!parsed.success) {
    problems.push(`invalid_fixture ${dir}/fixture.json`);
    return null;
  }
  const fixture = parsed.data;
  if (!fixture.synthetic) {
    if (dirFiles.has("bundle.json")) problems.push(`non_synthetic_bundle ${dir}/bundle.json`);
    return { dir, fixture, repoFiles: null, bundle: null };
  }
  const composed = composeBundle(dirFiles);
  if (composed === null) {
    problems.push(`invalid_bundle ${dir}/bundle.json`);
    return null;
  }
  const { bundle, repoFiles } = composed;
  if (bundle.family_id !== fixture.family_id || bundle.variant_id !== fixture.variant_id) {
    problems.push(`bundle_identity_mismatch ${dir}`);
  }
  if (fixture.hidden_ref.assertion_set_digest !== assertionSetDigest(bundle)) {
    problems.push(`assertion_set_digest mismatch ${dir}`);
  }
  if (fixture.content_digest !== bundleContentDigest(bundle)) {
    problems.push(`content_digest mismatch ${dir}`);
  }
  return { dir, fixture, repoFiles, bundle };
}

async function checkBaseShas(
  fixtures: readonly CorpusFixture[],
  scratch: GraderScratch,
  problems: string[],
): Promise<void> {
  for (const entry of fixtures) {
    if (entry.bundle === null || entry.repoFiles === null) continue;
    const base = await scratch.buildBase(entry.repoFiles);
    if (base !== entry.fixture.base_sha) {
      problems.push(`base_sha mismatch ${entry.dir}`);
    }
  }
}

function byDir(a: CorpusFixture, b: CorpusFixture): number {
  return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
}

export async function lintCorpus(root: string, opts: LintCorpusOptions): Promise<CorpusFixture[]> {
  const absRoot = resolve(root);
  const files = walkFiles(absRoot);
  const problems = collectFormatProblems(files);
  problems.push(...collectSanitizedProblems(absRoot, files));
  const dirs = groupFixtureDirs(absRoot, files, problems);
  const fixtures: CorpusFixture[] = [];
  for (const [dir, dirFiles] of dirs) {
    const linted = lintFixtureDir(dir, dirFiles, problems);
    if (linted !== null) fixtures.push(linted);
  }
  await checkBaseShas(fixtures, opts.scratch, problems);
  if (problems.length > 0) throw new CorpusLintError(problems);
  assertNoFamilyLeak(
    fixtures.map((f) => ({
      family_id: f.fixture.family_id,
      split: f.fixture.split,
      base_sha: f.fixture.base_sha,
      task_digest: f.fixture.task_digest,
    })),
  );
  if (opts.lock !== undefined) {
    assertHoldoutReservation(
      opts.lock,
      fixtures.map((f) => f.fixture),
    );
  }
  return [...fixtures].sort(byDir);
}

export function holdoutMetricFixtures(fixtures: readonly FixturePublic[]): FixturePublic[] {
  return fixtures.filter((f) => f.split === "holdout" && !f.synthetic);
}
