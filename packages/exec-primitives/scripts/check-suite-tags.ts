/**
 * check-suite-tags.ts — tag discipline for the qualification suites.
 *
 * Every test in the package contract suite (test/*.test.ts) and the infra-host
 * parity suite must carry a section tag ([B1], [B3], [B4], [B6], [B7], [B8],
 * [B10], [PERM] or [L6]) in its title. The union of suites must cover every
 * required tag at least once, so evidence claims about a boundary always trace
 * to at least one executed test.
 *
 * penumbra-host parity files are verbatim ports of the legacy adapter suite —
 * their titles are preserved intentionally, so they are only required to
 * declare at least one test each (they're already exercised by qualify.ts).
 *
 * Scans: the package contract suite must exercise the real spawn boundary —
 * no child_process stubbing or module-level mocking is allowed under test/.
 * (Spying on host-side sinks like console/stderr to prove silence is fine.)
 *
 * Usage: bun scripts/check-suite-tags.ts
 * Exit 0 when clean; one "finding:" line per violation otherwise.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const INFRA_TEST_DIR = join(PACKAGE_DIR, "qualification", "consumers", "infra-host", "test");
const PEN_TEST_DIR = join(PACKAGE_DIR, "qualification", "consumers", "penumbra-host", "test");

const REQUIRED_TAGS = new Set(["B1", "B3", "B4", "B6", "B7", "B8", "B10", "PERM", "L6"]);
const TAG_RE = /\[([A-Z][A-Z0-9]*)\]/;
const TITLE_RE = /\b(?:test|it)\s*\(\s*(["'`])([\s\S]*?)\1/;
const DESCRIBE_RE = /\bdescribe\s*\(\s*(["'`])([\s\S]*?)\1/g;

let failures = 0;
const findings: string[] = [];
const seen = new Map<string, number>();

function scanTaggedFile(path: string): void {
  const src = readFileSync(path, "utf8");
  const rel = path.slice(PACKAGE_DIR.length + 1);
  // A test inherits its tag from the nearest preceding describe() title —
  // suites group a boundary under one tagged describe rather than repeating
  // the tag on every title.
  const describes = [...src.matchAll(DESCRIBE_RE)].map((m) => ({
    index: m.index ?? 0,
    tag: TAG_RE.exec(m[2] ?? "")?.[1],
  }));
  const tests = src.matchAll(new RegExp(TITLE_RE.source, "g"));
  let count = 0;
  for (const m of tests) {
    count += 1;
    const title = m[2] ?? "";
    let tag = TAG_RE.exec(title)?.[1];
    if (tag === undefined) {
      const enclosing = describes.filter((d) => d.index < (m.index ?? 0)).at(-1);
      tag = enclosing?.tag;
    }
    if (tag === undefined || !REQUIRED_TAGS.has(tag)) {
      findings.push(`${rel}: untagged test title ${JSON.stringify(title.slice(0, 80))}`);
      continue;
    }
    seen.set(tag, (seen.get(tag) ?? 0) + 1);
  }
  if (count === 0) findings.push(`${rel}: no tests found`);
}

const FORBIDDEN_TEST_PATTERNS: { re: RegExp; rule: string }[] = [
  { re: /\bspyOn\s*\(\s*(?:childProcess|cp|nodeProcess)\b/, rule: "spawn-stub" },
  { re: /\bmock\.module\s*\(/, rule: "module-mock" },
  { re: /\brequire\s*\(\s*["']node:child_process["']\s*\)/, rule: "cjs-spawn-import" },
];

function scanPresenceFile(path: string): void {
  const src = readFileSync(path, "utf8");
  const rel = path.slice(PACKAGE_DIR.length + 1);
  if (!TITLE_RE.test(src)) findings.push(`${rel}: no tests found`);
}

for (const f of readdirSync(join(PACKAGE_DIR, "test")).filter((n) => n.endsWith(".test.ts"))) {
  const path = join(PACKAGE_DIR, "test", f);
  scanTaggedFile(path);
  const src = readFileSync(path, "utf8");
  for (const { re, rule } of FORBIDDEN_TEST_PATTERNS) {
    const lines = src.split("\n");
    for (const [i, line] of lines.entries()) {
      if (re.test(line)) {
        findings.push(`test/${f}:${String(i + 1)} [${rule}] ${line.trim()}`);
      }
    }
  }
}
for (const f of readdirSync(INFRA_TEST_DIR).filter((n) => n.endsWith(".mjs"))) {
  scanTaggedFile(join(INFRA_TEST_DIR, f));
}
for (const f of readdirSync(PEN_TEST_DIR).filter(
  (n) => n.endsWith(".parity.ts") && !n.includes("contract"),
)) {
  scanPresenceFile(join(PEN_TEST_DIR, f));
}

for (const tag of REQUIRED_TAGS) {
  if (!seen.has(tag)) findings.push(`tag [${tag}] has zero coverage across the scanned suites`);
}

for (const f of findings) {
  process.stdout.write(`finding: ${f}\n`);
  failures += 1;
}
if (failures === 0) {
  const census = [...REQUIRED_TAGS]
    .sort()
    .map((t) => `${t}:${String(seen.get(t) ?? 0)}`)
    .join(" ");
  process.stdout.write(`suite-tags: PASS (${census})\n`);
} else {
  process.stdout.write(`suite-tags: FAIL (${String(failures)})\n`);
}
process.exit(failures === 0 ? 0 : 1);
