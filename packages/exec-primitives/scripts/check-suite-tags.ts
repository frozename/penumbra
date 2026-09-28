/**
 * check-suite-tags.ts — tag discipline for the qualification suites.
 *
 * Package contract suite (test/*.test.ts): every test carries a boundary tag
 * ([B1], [B3], [B4], [B6], [B7], [B8], [B10], [PERM], [L6]) on its title or on
 * the nearest enclosing describe(). Tag minimums and the ≥15-test floor are
 * counted from EXECUTED titles — the suite is run and the (pass)/(fail) lines
 * parsed — so a deleted or commented-out test can never count toward a
 * minimum. The run must agree with bun's own JUnit report
 * (bun-test-junit.ts), and every executed title must match a static test(
 * title in the comment-stripped sources (suite-titles.ts), so a result line
 * printed by test code cannot count either.
 *
 * infra-host parity suite (consumers/infra-host/test/*.parity.ts): tags go on
 * test titles directly, and every required infra id ([T1], [T3], [T4], [T6],
 * [T7], [ACP-CLIENTINFO], [ACP-ENVKEYS], [PERM-DENY], [SCOPE-2], [B8],
 * [PARTIAL-NONZERO], [ERROR-THEN-EXIT], [GUARD]) must appear at least once,
 * with at least 13 tests total. Consumer sources are TypeScript (src/**,
 * test/*.parity.ts); plain-JS is permitted only under fixtures/ for spawned
 * child programs (fake-acp.mjs), so any stray .mjs/.js under src/ or test/ is
 * reported. Consumer titles cannot be executed here (the package is not
 * installed), so they are counted from comment-stripped source — a
 * commented-out test still cannot satisfy an id.
 *
 * penumbra-host parity files are verbatim ports of the legacy adapter suite —
 * titles are preserved intentionally; each file must declare at least one
 * test, and each consumer must carry a [GUARD]-tagged test.
 *
 * Forbidden in the scanned suites (test/ — recursively, helpers included —
 * plus consumers' test/ and fixtures/): skipped/exclusive tests, module
 * mocking (mock.module/jest.mock/vi.mock*), and any spyOn whose target isn't
 * process.stderr, process.stdout or console — child_process/spawn spying is
 * explicitly banned so the suites always cross the real process boundary.
 *
 * Usage: bun scripts/check-suite-tags.ts
 * Exit 0 when clean; one "finding:" line per violation otherwise.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { junitArgs, verifyBunTestRun } from "./bun-test-junit.js";
import { agentFreeEnv } from "./bun-test-parse.js";
import { stripComments } from "./closure-audit-core.js";
import { describeTitlesOf, testSources, titlesOf, unmatchedTitles } from "./suite-titles.js";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const TEST_DIR = join(PACKAGE_DIR, "test");
const CONSUMERS_DIR = join(PACKAGE_DIR, "qualification", "consumers");
const INFRA_DIR = join(CONSUMERS_DIR, "infra-host");
const PEN_DIR = join(CONSUMERS_DIR, "penumbra-host");
const JUNIT_PATH = join(PACKAGE_DIR, "..", "..", "tmp", "sharedlib6", "junit", "suite-tags.xml");

/** Package-suite boundary tags and their distinct-test minimums. */
const TAG_MINIMUMS: Record<string, number> = {
  B1: 1,
  B3: 2,
  B4: 2,
  B6: 1,
  B7: 1,
  B8: 2,
  B10: 5,
  PERM: 1,
  L6: 1,
};
const MIN_PACKAGE_TESTS = 15;

/** infra-host ids — item-6 contract; each must appear on a test title. */
const INFRA_REQUIRED_IDS = [
  "T1",
  "T3",
  "T4",
  "T6",
  "T7",
  "ACP-CLIENTINFO",
  "ACP-ENVKEYS",
  "PERM-DENY",
  "SCOPE-2",
  "B8",
  "PARTIAL-NONZERO",
  "ERROR-THEN-EXIT",
  "GUARD",
];
const MIN_INFRA_TESTS = 13;

const TAG_RE = /\[([A-Z][A-Z0-9-]*)\]/;

const findings: string[] = [];

function rel(path: string): string {
  return path.slice(PACKAGE_DIR.length + 1);
}

function describesOf(src: string): { index: number; tag: string | undefined }[] {
  return describeTitlesOf(src).map((d) => ({ index: d.index, tag: TAG_RE.exec(d.text)?.[1] }));
}

/** Executed test titles — "(pass) describe > test [12ms]" lines on stderr
 * from a real `bun test` run under agentFreeEnv(), deduped. test.each rows
 * resolve into distinct executions. `problem` is set when the stderr results
 * cannot account for bun's summary or disagree with bun's JUnit report
 * (bun-test-junit.ts) — the count is then refused. */
function executedTitles(): { titles: string[]; ran: boolean; problem: string | undefined } {
  const r = spawnSync("bun", ["test", "test/", ...junitArgs(JUNIT_PATH)], {
    cwd: PACKAGE_DIR,
    env: agentFreeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  const { parse, problem } = verifyBunTestRun(r, JUNIT_PATH, "test/");
  return { titles: parse.titles, ran: parse.summary.ran !== null, problem };
}

// Scope A — scanned for skip/mock patterns: package test/ plus every
// consumer's test/ and fixtures/.
const FORBIDDEN_LINE_PATTERNS: { re: RegExp; rule: string }[] = [
  {
    re: /\b(?:test|it|describe)\s*\.\s*(?:skip|todo|only|skipIf|todoIf|if)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(/,
    rule: "skipped-or-exclusive-test",
  },
  { re: /\bmock\.module\s*\(|\bjest\.mock\s*\(|\bvi\.(?:doMock|mock)\s*\(/, rule: "module-mock" },
];

// Scope B — additionally scanned for spawn stubs: package test/, all of
// infra-host, penumbra-host src/, and the penumbra-host re-expression files.
// (Verbatim adapter ports legitimately stub spawn at the shim boundary — that
// is what they are for — so penumbra-host/test/*.parity.ts ports are exempt.)
const SPAWN_STUB_RE = /\bspyOn\s*\([^)]*\b(?:child_process|spawn)\b/;
const ALLOWED_SPY_TARGETS = /\bspyOn\s*\(\s*(?:process\.stderr|process\.stdout|console)\s*,/;

function scanSpyLine(path: string, i: number, line: string): void {
  if (SPAWN_STUB_RE.test(line)) {
    findings.push(`${rel(path)}:${String(i + 1)} [spawn-stub] ${line.trim()}`);
  }
  if (/\bspyOn\s*\(/.test(line) && !ALLOWED_SPY_TARGETS.test(line)) {
    findings.push(
      `${rel(path)}:${String(i + 1)} [spy-target] only process.stderr, process.stdout or console may be spied: ${line.trim()}`,
    );
  }
}

function scanForbidden(path: string, spyScope: boolean): void {
  // Comments are blanked before scanning: a commented-out test.skip or spyOn
  // is not a live finding, and live patterns can never hide inside comments.
  const src = stripComments(readFileSync(path, "utf8"));
  const lines = src.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const { re, rule } of FORBIDDEN_LINE_PATTERNS) {
      if (re.test(line)) findings.push(`${rel(path)}:${String(i + 1)} [${rule}] ${line.trim()}`);
    }
    if (spyScope) scanSpyLine(path, i, line);
  }
}

function listFiles(dir: string, filter: (n: string) => boolean): string[] {
  try {
    return readdirSync(dir)
      .filter(filter)
      .map((n) => join(dir, n));
  } catch {
    findings.push(`${rel(dir)}: unreadable or missing directory`);
    return [];
  }
}

/** Recursive variant — consumer src trees nest (e.g. penumbra-host/src/shim). */
function listFilesDeep(dir: string, filter: (n: string) => boolean): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    findings.push(`${rel(dir)}: unreadable or missing directory`);
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesDeep(full, filter));
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// --- package contract suite: executed titles drive tag minimums ---
const { titles: executed, ran: suiteRan, problem: titleProblem } = executedTitles();
if (!suiteRan) {
  findings.push("test/: bun test never reached its summary line — cannot count executed titles");
}
if (titleProblem !== undefined) findings.push(titleProblem);
// Every executed title must come from a test( call in the comment-stripped
// sources: a result line printed by test code names no such call.
for (const t of unmatchedTitles(executed, testSources(TEST_DIR))) {
  findings.push(`test/: executed title with no static test( title: ${JSON.stringify(t)}`);
}
// Executed lines are "describe > ... > test": the test's own tag wins, then
// the nearest enclosing describe — same resolution as the static pass below.
function executedTag(title: string): string | undefined {
  const segs = title.split(" > ");
  for (let i = segs.length - 1; i >= 0; i--) {
    const tag = TAG_RE.exec(segs[i] ?? "")?.[1];
    if (tag !== undefined) return tag;
  }
  return undefined;
}

const seen = new Map<string, number>();
for (const t of executed) {
  const tag = executedTag(t);
  if (tag === undefined || !(tag in TAG_MINIMUMS)) {
    findings.push(`test/: untagged executed title ${JSON.stringify(t.slice(0, 100))}`);
    continue;
  }
  seen.set(tag, (seen.get(tag) ?? 0) + 1);
}
if (executed.length < MIN_PACKAGE_TESTS) {
  findings.push(
    `test/: only ${String(executed.length)} executed tests — minimum ${String(MIN_PACKAGE_TESTS)}`,
  );
}
for (const [tag, min] of Object.entries(TAG_MINIMUMS)) {
  const count = seen.get(tag) ?? 0;
  if (count < min) {
    findings.push(`tag [${tag}] has ${String(count)} distinct tests — minimum ${String(min)}`);
  }
}

// Static pass for per-file checks + forbidden-pattern scan over the whole
// test tree (helpers included). Comment-stripped so dead code cannot count.
for (const path of listFilesDeep(TEST_DIR, (n) => n.endsWith(".ts"))) {
  scanForbidden(path, true);
}
for (const path of listFiles(TEST_DIR, (n) => n.endsWith(".test.ts"))) {
  const src = stripComments(readFileSync(path, "utf8"));
  const titles = titlesOf(src);
  if (titles.length === 0) findings.push(`${rel(path)}: no tests found`);
  const describes = describesOf(src);
  for (const t of titles) {
    const tag = TAG_RE.exec(t.text)?.[1] ?? describes.filter((d) => d.index < t.index).at(-1)?.tag;
    if (tag === undefined) {
      findings.push(`${rel(path)}: untagged test title ${JSON.stringify(t.text.slice(0, 80))}`);
    }
  }
}

// --- consumers: TypeScript contract — no plain-JS sources outside fixtures ---
for (const consumer of [INFRA_DIR, PEN_DIR]) {
  for (const sub of ["src", "test"]) {
    for (const path of listFilesDeep(join(consumer, sub), (n) => /\.(?:mjs|cjs|js)$/.test(n))) {
      findings.push(
        `${rel(path)}: consumer sources must be TypeScript (.ts); plain JS only allowed in fixtures/`,
      );
    }
  }
}

// --- infra-host: ids on test titles (comment-stripped static count) ---
const infraSeen = new Map<string, number>();
let infraTests = 0;
const infraTestDir = join(INFRA_DIR, "test");
for (const path of listFiles(infraTestDir, (n) => n.endsWith(".parity.ts"))) {
  const src = stripComments(readFileSync(path, "utf8"));
  const titles = titlesOf(src);
  if (titles.length === 0) findings.push(`${rel(path)}: no tests found`);
  infraTests += titles.length;
  for (const t of titles) {
    const tags = [...t.text.matchAll(new RegExp(TAG_RE.source, "g"))].map((m) => m[1] ?? "");
    if (tags.length === 0) {
      findings.push(
        `${rel(path)}: untagged infra test title ${JSON.stringify(t.text.slice(0, 80))}`,
      );
    }
    for (const tag of tags) infraSeen.set(tag, (infraSeen.get(tag) ?? 0) + 1);
  }
}
if (infraTests < MIN_INFRA_TESTS) {
  findings.push(
    `infra-host: only ${String(infraTests)} tests — minimum ${String(MIN_INFRA_TESTS)}`,
  );
}
for (const id of INFRA_REQUIRED_IDS) {
  if (!infraSeen.has(id)) {
    findings.push(`infra-host: required id [${id}] absent from all test titles`);
  }
}

// --- penumbra-host parity files: presence + a [GUARD] title per consumer ---
let penGuard = false;
for (const path of listFiles(join(PEN_DIR, "test"), (n) => n.endsWith(".parity.ts"))) {
  const src = stripComments(readFileSync(path, "utf8"));
  const titles = titlesOf(src);
  if (titles.length === 0) findings.push(`${rel(path)}: no tests found`);
  if (titles.some((t) => TAG_RE.exec(t.text)?.[1] === "GUARD")) penGuard = true;
}
if (!penGuard) {
  findings.push("penumbra-host: no [GUARD]-tagged test title");
}
if (!infraSeen.has("GUARD")) {
  findings.push("infra-host: no [GUARD]-tagged test title");
}

// --- forbidden patterns: skip/mock across consumers' test/ + fixtures/ ---
for (const consumer of [INFRA_DIR, PEN_DIR]) {
  for (const sub of ["test", "fixtures"]) {
    const dir = join(consumer, sub);
    for (const path of listFiles(dir, (n) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(n))) {
      scanForbidden(path, false);
    }
  }
}
// spyOn/spawn-stub scope: all of infra-host, penumbra-host src/, and the
// penumbra-host re-expression files (verbatim ports are exempt — the legacy
// adapter suite stubs spawn at the shim boundary by design).
const REEXPRESSION_FILES = new Set([
  "stdio-acp-permission.parity.ts",
  "cli-spawn-stream.parity.ts",
]);
for (const sub of ["test", "fixtures", "src"]) {
  for (const path of listFilesDeep(join(INFRA_DIR, sub), (n) =>
    /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(n),
  )) {
    scanForbidden(path, true);
  }
}
for (const path of listFilesDeep(join(PEN_DIR, "src"), (n) => /\.(?:ts|mts|cts)$/.test(n))) {
  scanForbidden(path, true);
}
for (const path of listFiles(join(PEN_DIR, "test"), (n) => REEXPRESSION_FILES.has(n))) {
  scanForbidden(path, true);
}

for (const f of findings) {
  process.stdout.write(`finding: ${f}\n`);
}
if (findings.length === 0) {
  const census = Object.keys(TAG_MINIMUMS)
    .sort()
    .map((t) => `${t}:${String(seen.get(t) ?? 0)}`)
    .join(" ");
  const infraCensus = INFRA_REQUIRED_IDS.map((t) => `${t}:${String(infraSeen.get(t) ?? 0)}`).join(
    " ",
  );
  process.stdout.write(
    `suite-tags: PASS (package ${census}; ${String(executed.length)} executed tests | infra ${infraCensus}; ${String(infraTests)} tests)\n`,
  );
} else {
  process.stdout.write(`suite-tags: FAIL (${String(findings.length)})\n`);
}
process.exit(findings.length === 0 ? 0 : 1);
