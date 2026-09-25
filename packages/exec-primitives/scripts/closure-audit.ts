/**
 * closure-audit.ts — static boundary audit for the exec-primitives package.
 *
 * Modes:
 *   --src              audit packages/exec-primitives/src/**
 *   --tarball <dir>    audit <dir>/package/dist/src/** (.js and .d.ts) + manifest
 *   --consumers        audit qualification/consumers/*&#47;{src,test,fixtures}/**
 *   --self-test        audit qualification/audit-fixtures/* (each must behave
 *                      as expected) then the real src/**; a missing fixture fails
 *
 * Exit 0 when clean; exit 1 with one "finding:" line per violation otherwise.
 * Counts are printed as JSON so evidence can copy them verbatim.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const QUALIFICATION_DIR = join(PACKAGE_DIR, "qualification");
const FIXTURES_DIR = join(QUALIFICATION_DIR, "audit-fixtures");
const ALLOWLIST_PATH = join(QUALIFICATION_DIR, "audit-allowlist.json");
const DIST_ALLOWLIST_PATH = join(QUALIFICATION_DIR, "audit-allowlist-dist.json");

interface Finding {
  file: string;
  line: number;
  rule: string;
  token: string;
  text: string;
}

interface Specifier {
  specifier: string;
  kind: "static" | "export" | "dynamic" | "reference";
  typeOnly: boolean;
  file: string;
  line: number;
}

interface ScanResult {
  files: number;
  lines: number;
  bytes: number;
  specifiers: Specifier[];
  mutableBindings: number;
  findings: Finding[];
}

interface AllowEntry {
  file: string;
  line: number;
  token: string;
  classification: string;
  reason: string;
}

const RUNTIME_NODE_BUILTINS = new Set(["child_process", "readline", "stream", "events"]);
const BANNED_NODE_BUILTINS = new Set([
  "fs",
  "os",
  "net",
  "http",
  "https",
  "dgram",
  "worker_threads",
  "path",
  "url",
]);
const CONSUMER_SRC_BANNED_BUILTINS = new Set([
  "child_process",
  "readline",
  "net",
  "worker_threads",
]);
const FORBIDDEN_SPECIFIER_SCHEME = /^(?:@penumbra\/|@src\/|workspace:|file:|link:|bun:)/;

const TOKEN_RULES: { rule: string; re: RegExp }[] = [
  { rule: "process-env", re: /\bprocess\.env\b/ },
  { rule: "process-cwd", re: /\bprocess\.cwd\b/ },
  { rule: "process-stdout", re: /\bprocess\.stdout\b/ },
  { rule: "process-stderr", re: /\bprocess\.stderr\b/ },
  { rule: "process-on", re: /\bprocess\.on\s*\(/ },
  { rule: "process-kill-pid", re: /\bprocess\.kill\s*\(\s*[^-]/ },
  { rule: "console", re: /\bconsole\./ },
  { rule: "fetch", re: /\bfetch\s*\(/ },
  { rule: "websocket", re: /\bWebSocket\b/ },
  { rule: "create-require", re: /\bcreateRequire\b/ },
  { rule: "require-call", re: /(?:^|[^.\w$])require\s*\(/ },
  { rule: "global-this", re: /\bglobalThis\b/ },
  { rule: "symbol-for", re: /\bSymbol\.for\s*\(/ },
  { rule: "eval", re: /\beval\s*\(/ },
  { rule: "function-ctor", re: /\bnew\s+Function\s*\(/ },
  { rule: "homedir", re: /\bhomedir\b/ },
  { rule: "penumbra-home", re: /\.penumbra\b/ },
  { rule: "config-dir", re: /\.config\// },
  { rule: "penumbra-env", re: /\bPENUMBRA_[A-Z0-9_]+\b/ },
  { rule: "trust-mode", re: /\btrust_mode\b/i },
  { rule: "handoff", re: /\bhandoff\b/i },
  { rule: "dispatch-event", re: /\bDispatchEvent\b/ },
  { rule: "thought-capture", re: /\bthoughtCapture\b/i },
];

const POLICY_TOKEN_RE =
  /\b[A-Za-z_$]*(?:retry|fallback|takeover|reconnect|resume|adopt|attach|pidfile|connect|lookup)[A-Za-z_$]*\b/gi;

const FIXTURE_EXPECTATIONS: {
  name: string;
  mode: "code" | "consumer";
  rule: string;
  token: string;
}[] = [
  {
    name: "a-penumbra-core-type-import",
    mode: "code",
    rule: "forbidden-specifier",
    token: "@penumbra/core",
  },
  {
    name: "a-penumbra-core-dynamic-import",
    mode: "code",
    rule: "dynamic-import",
    token: "@penumbra/core",
  },
  {
    name: "a-src-alias",
    mode: "code",
    rule: "forbidden-specifier",
    token: "@src/adapters/helper.js",
  },
  {
    name: "a-relative-escape",
    mode: "code",
    rule: "relative-escape",
    token: "../../../agentchat/src/adapters/helper.js",
  },
  { name: "a-node-fs", mode: "code", rule: "node-builtin", token: "node:fs" },
  { name: "a-process-env", mode: "code", rule: "process-env", token: "process-env" },
  { name: "a-console", mode: "code", rule: "console", token: "console" },
  {
    name: "a-dependencies-key",
    mode: "code",
    rule: "dependencies-key",
    token: "dependencies",
  },
  { name: "b-top-level-let", mode: "code", rule: "mutable-binding", token: "let|var" },
  { name: "b-const-map", mode: "code", rule: "mutable-binding", token: "container" },
  { name: "b-const-annotated-array", mode: "code", rule: "mutable-binding", token: "container" },
  { name: "b-const-object-literal", mode: "code", rule: "mutable-binding", token: "container" },
  { name: "b-static-member", mode: "code", rule: "mutable-binding", token: "container" },
  { name: "c-unlisted-fallback", mode: "code", rule: "policy-token", token: "fallbacktolocal" },
  {
    name: "c-stale-allowlist",
    mode: "code",
    rule: "stale-allowlist",
    token: "nomatchtokenhere",
  },
  {
    name: "d-consumer-dist-path",
    mode: "consumer",
    rule: "consumer-banned-path",
    token: "./dist/internal.js",
  },
  {
    name: "d-consumer-packages-path",
    mode: "consumer",
    rule: "consumer-banned-path",
    token: "../../packages/agentchat/src/adapters/helper.js",
  },
  {
    name: "d-consumer-child-process",
    mode: "consumer",
    rule: "consumer-node-builtin",
    token: "node:child_process",
  },
  {
    name: "d-consumer-shim-no-package-import",
    mode: "consumer",
    rule: "consumer-no-package-import",
    token: "penumbra-exec-primitives",
  },
  { name: "d-consumer-guard-dynamic-import", mode: "consumer", rule: "", token: "" },
  { name: "clean", mode: "code", rule: "", token: "" },
];

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (m) => m.replaceAll(/[^\n]/g, " "))
    .replaceAll(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function collectFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...collectFiles(path, extensions));
    else if (extensions.some((ext) => name.endsWith(ext))) out.push(path);
  }
  return out.sort();
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function extractSpecifiers(raw: string, stripped: string, rel: string): Specifier[] {
  const out: Specifier[] = [];
  for (const m of raw.matchAll(/^\s*\/\/\/\s*<reference\s+(?:types|path)="([^"]+)"/gm)) {
    out.push({
      specifier: m[1] ?? "",
      kind: "reference",
      typeOnly: true,
      file: rel,
      line: lineOf(raw, m.index),
    });
  }
  for (const m of stripped.matchAll(
    /(?:^|\n)\s*(import|export)\s([^;]*?)\bfrom\s*["']([^"'\n]+)["']/g,
  )) {
    const stmt = m[2] ?? "";
    out.push({
      specifier: m[3] ?? "",
      kind: m[1] === "export" ? "export" : "static",
      typeOnly: /^\s*type\b/.test(stmt),
      file: rel,
      line: lineOf(stripped, m.index),
    });
  }
  for (const m of stripped.matchAll(/(?:^|\n)\s*import\s*["']([^"'\n]+)["']/g)) {
    out.push({
      specifier: m[1] ?? "",
      kind: "static",
      typeOnly: false,
      file: rel,
      line: lineOf(stripped, m.index),
    });
  }
  for (const m of stripped.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    const arg = (m[1] ?? "").trim();
    const literal = /^["']([^"'\n]*)["']$/.exec(arg)?.[1];
    out.push({
      specifier: literal ?? `import(${arg})`,
      kind: "dynamic",
      typeOnly: false,
      file: rel,
      line: lineOf(stripped, m.index),
    });
  }
  return out;
}

function resolvesOutside(root: string, fileRel: string, specifier: string): boolean {
  const target = normalize(join(dirname(fileRel), specifier));
  return target === ".." || target.startsWith(`..${sep}`) || target.startsWith("../");
}

function specifierKind(specifier: string): "node" | "relative" | "forbidden" | "bare" {
  if (specifier.startsWith("node:")) return "node";
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (FORBIDDEN_SPECIFIER_SCHEME.test(specifier)) return "forbidden";
  return "bare";
}

function auditManifest(root: string, result: ScanResult): void {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if ("dependencies" in manifest) {
    result.findings.push({
      file: "package.json",
      line: 0,
      rule: "dependencies-key",
      token: "dependencies",
      text: '"dependencies"',
    });
  }
}

function auditSpecifier(
  result: ScanResult,
  rel: string,
  root: string,
  spec: Specifier,
): void {
  const finding = (rule: string, token: string): void => {
    result.findings.push({ file: rel, line: spec.line, rule, token, text: spec.specifier });
  };
  if (spec.kind === "dynamic") {
    const okLiteral = spec.specifier.startsWith("./") || spec.specifier.startsWith("../");
    if (!okLiteral) {
      finding("dynamic-import", spec.specifier);
      return;
    }
    if (resolvesOutside(root, rel, spec.specifier)) finding("relative-escape", spec.specifier);
    return;
  }
  const kind = specifierKind(spec.specifier);
  if (kind === "forbidden") {
    finding("forbidden-specifier", spec.specifier);
  } else if (kind === "node") {
    const builtin = spec.specifier.slice(5).split("/")[0] ?? "";
    if (!RUNTIME_NODE_BUILTINS.has(builtin)) finding("node-builtin", spec.specifier);
  } else if (kind === "relative") {
    if (resolvesOutside(root, rel, spec.specifier)) finding("relative-escape", spec.specifier);
  } else {
    finding("bare-specifier", spec.specifier);
  }
}

const MUTABLE_BINDING_RE =
  /^(?:export\s+)?const\s+\w+\s*(?::[^=;\n]*)?=\s*(?:\{|\[|new\s+(?:Map|Set|WeakMap|WeakSet)\b)/;
const STATIC_CONTAINER_RE =
  /\bstatic\s+(?:readonly\s+)?\w+\s*(?::[^=;\n]*)?=\s*(?:\{|\[|new\s+(?:Map|Set|WeakMap|WeakSet)\b)/;

function auditFileLines(
  result: ScanResult,
  hitLines: { file: string; line: number; token: string }[],
  rel: string,
  lines: string[],
): void {
  for (const [i, line] of lines.entries()) {
    if (
      /^(?:export\s+)?(?:let|var)\s/.test(line) ||
      MUTABLE_BINDING_RE.test(line) ||
      STATIC_CONTAINER_RE.test(line)
    ) {
      result.mutableBindings += 1;
      result.findings.push({
        file: rel,
        line: i + 1,
        rule: "mutable-binding",
        token: /^(?:export\s+)?(?:let|var)\s/.test(line) ? "let|var" : "container",
        text: line.trim(),
      });
    }
    for (const { rule, re } of TOKEN_RULES) {
      if (re.test(line)) {
        result.findings.push({ file: rel, line: i + 1, rule, token: rule, text: line.trim() });
      }
    }
    for (const m of line.matchAll(POLICY_TOKEN_RE)) {
      hitLines.push({ file: rel, line: i + 1, token: m[0].toLowerCase() });
    }
  }
}

function auditCodeFile(
  result: ScanResult,
  hitLines: { file: string; line: number; token: string }[],
  root: string,
  path: string,
): void {
  const rel = relative(root, path);
  const raw = readFileSync(path, "utf8");
  const stripped = stripComments(raw);
  result.files += 1;
  result.lines += raw.split("\n").length - 1;
  result.bytes += Buffer.byteLength(raw, "utf8");
  const specifiers = extractSpecifiers(raw, stripped, rel);
  result.specifiers.push(...specifiers);
  for (const spec of specifiers) auditSpecifier(result, rel, root, spec);
  auditFileLines(result, hitLines, rel, stripped.split("\n"));
}

function resolveAllowlist(
  result: ScanResult,
  allowlist: AllowEntry[],
  hitLines: { file: string; line: number; token: string }[],
): void {
  const used = new Set<number>();
  for (const hit of hitLines) {
    const matched = allowlist.findIndex(
      (entry, idx) =>
        !used.has(idx) &&
        entry.file === hit.file &&
        entry.line === hit.line &&
        hit.token.includes(entry.token.toLowerCase()),
    );
    if (matched === -1) {
      result.findings.push({
        file: hit.file,
        line: hit.line,
        rule: "policy-token",
        token: hit.token,
        text: hit.token,
      });
      continue;
    }
    used.add(matched);
    const entry = allowlist[matched];
    const valid =
      entry !== undefined &&
      (entry.classification === "pre-approved" ||
        (entry.classification === "false-positive" && entry.reason.startsWith("false-positive:")));
    if (!valid) {
      result.findings.push({
        file: hit.file,
        line: hit.line,
        rule: "policy-token",
        token: hit.token,
        text: `bad-allowlist-classification:${String(entry?.classification)}`,
      });
    }
  }
  for (const [idx, entry] of allowlist.entries()) {
    if (!used.has(idx)) {
      result.findings.push({
        file: entry.file,
        line: entry.line,
        rule: "stale-allowlist",
        token: entry.token,
        text: `${entry.file}:${String(entry.line)} ${entry.token}`,
      });
    }
  }
}

function auditCodeRoot(root: string, extensions: string[], allowlist: AllowEntry[]): ScanResult {
  const result: ScanResult = {
    files: 0,
    lines: 0,
    bytes: 0,
    specifiers: [],
    mutableBindings: 0,
    findings: [],
  };
  const hitLines: { file: string; line: number; token: string }[] = [];
  auditManifest(root, result);
  for (const path of collectFiles(root, extensions)) {
    auditCodeFile(result, hitLines, root, path);
  }
  resolveAllowlist(result, allowlist, hitLines);
  return result;
}

function collectConsumerFiles(dir: string): string[] {
  // Scan every code file under the consumer root except installed/generated
  // dependency trees — vendored artifacts and lockfile contents are not
  // consumer source.
  const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", ".git"]);
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...collectConsumerFiles(path));
      continue;
    }
    if ([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((ext) => name.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

function auditConsumerBareSpecifier(
  result: ScanResult,
  rel: string,
  spec: Specifier,
  inTestOrFixtures: boolean,
): void {
  const s = spec.specifier;
  const finding = (rule: string): void => {
    result.findings.push({ file: rel, line: spec.line, rule, token: s, text: s });
  };
  if (specifierKind(s) === "forbidden") {
    // bun:test is the one bun: scheme a consumer test may legally load.
    // A dynamic import in a test/fixture file is the poison-tripwire pattern:
    // qualify installs a throwing stub, the test asserts the specifier rejects
    // with it. Static forbidden imports stay banned everywhere (they would
    // link a real penumbra package); dynamic imports in src stay banned too.
    const poisonTripwire = spec.kind === "dynamic" && inTestOrFixtures;
    if (!poisonTripwire && !(inTestOrFixtures && s === "bun:test")) {
      finding("consumer-bare-specifier");
    }
    return;
  }
  const bareOk = s === "penumbra-exec-primitives" || (inTestOrFixtures && s === "bun:test");
  if (!bareOk) finding("consumer-bare-specifier");
}

function auditConsumerSpecifier(
  result: ScanResult,
  rel: string,
  spec: Specifier,
  root: string,
): void {
  const s = spec.specifier;
  const inSrc = rel.startsWith(`src${sep}`) || rel.startsWith("src/");
  const inTestOrFixtures = rel.startsWith("test/") || rel.startsWith("fixtures/");
  const finding = (rule: string): void => {
    result.findings.push({ file: rel, line: spec.line, rule, token: s, text: s });
  };
  if (s.includes("packages/") || s.includes("exec-primitives/src") || s.includes("/dist/")) {
    finding("consumer-banned-path");
    return;
  }
  const kind = specifierKind(s);
  if (kind === "relative") {
    if (resolvesOutside(root, rel, s)) finding("consumer-relative-escape");
    return;
  }
  if (kind === "node") {
    const builtin = s.slice(5).split("/")[0] ?? "";
    if (inSrc && CONSUMER_SRC_BANNED_BUILTINS.has(builtin)) finding("consumer-node-builtin");
    return;
  }
  auditConsumerBareSpecifier(result, rel, spec, inTestOrFixtures);
}

function auditConsumerFile(
  result: ScanResult,
  root: string,
  path: string,
  filesByPath: Map<string, Specifier[]>,
): void {
  const rel = relative(root, path);
  const raw = readFileSync(path, "utf8");
  const stripped = stripComments(raw);
  result.files += 1;
  result.lines += raw.split("\n").length - 1;
  result.bytes += Buffer.byteLength(raw, "utf8");
  const specifiers = extractSpecifiers(raw, stripped, rel);
  result.specifiers.push(...specifiers);
  filesByPath.set(rel, specifiers);
  for (const spec of specifiers) {
    auditConsumerSpecifier(result, rel, spec, root);
  }
}

function auditConsumerRoot(root: string): ScanResult {
  const result: ScanResult = {
    files: 0,
    lines: 0,
    bytes: 0,
    specifiers: [],
    mutableBindings: 0,
    findings: [],
  };
  const files = collectConsumerFiles(root);
  if (files.length === 0) {
    result.findings.push({
      file: ".",
      line: 0,
      rule: "consumer-empty",
      token: root,
      text: "consumer has no code files",
    });
  }

  const filesByPath = new Map<string, Specifier[]>();
  for (const path of files.sort()) {
    auditConsumerFile(result, root, path, filesByPath);
  }

  for (const [rel, specifiers] of filesByPath) {
    const inSrc = rel.startsWith("src/");
    const exempt =
      rel === "src/smoke.ts" || rel === "src/smoke.mjs" || rel.endsWith("shim/types.ts");
    if (!inSrc || exempt) continue;
    const hasPackageImport = specifiers.some(
      (spec) => !spec.typeOnly && spec.specifier === "penumbra-exec-primitives",
    );
    if (!hasPackageImport) {
      result.findings.push({
        file: rel,
        line: 0,
        rule: "consumer-no-package-import",
        token: "penumbra-exec-primitives",
        text: rel,
      });
    }
  }
  return result;
}

function loadAllowlist(path: string): AllowEntry[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(raw) ? (raw as AllowEntry[]) : [];
}

function printResult(label: string, result: ScanResult): void {
  const runtime = result.specifiers.filter((s) => !s.typeOnly).length;
  const typeOnly = result.specifiers.filter((s) => s.typeOnly).length;
  const counts = {
    files: result.files,
    lines: result.lines,
    bytes: result.bytes,
    specifiers: result.specifiers.length,
    runtimeSpecifiers: runtime,
    typeOnlySpecifiers: typeOnly,
    mutableBindings: result.mutableBindings,
    violations: result.findings.length,
  };
  process.stdout.write(`counts ${label}: ${JSON.stringify(counts)}\n`);
  for (const f of result.findings) {
    process.stdout.write(
      `finding: ${f.file}:${String(f.line)} [${f.rule}] ${f.token} :: ${f.text}\n`,
    );
  }
}

function auditAndPrint(
  label: string,
  root: string,
  mode: "code" | "consumer",
  extensions: string[],
  allowlistPath: string,
): ScanResult {
  if (!existsSync(root)) {
    process.stdout.write(`finding: ${label}:0 [missing-dir] ${root}\n`);
    return {
      files: 0,
      lines: 0,
      bytes: 0,
      specifiers: [],
      mutableBindings: 0,
      findings: [{ file: label, line: 0, rule: "missing-dir", token: root, text: root }],
    };
  }
  const result =
    mode === "consumer"
      ? auditConsumerRoot(root)
      : auditCodeRoot(root, extensions, loadAllowlist(allowlistPath));
  printResult(label, result);
  return result;
}

function checkFixture(fixture: (typeof FIXTURE_EXPECTATIONS)[number]): string[] {
  const dir = join(FIXTURES_DIR, fixture.name);
  if (!existsSync(dir)) return [`missing fixture ${fixture.name}`];
  const result =
    fixture.mode === "consumer"
      ? auditConsumerRoot(dir)
      : auditCodeRoot(
          dir,
          [".ts", ".js", ".mjs", ".d.ts"],
          loadAllowlist(join(dir, "audit-allowlist.json")),
        );
  const hits = result.findings;
  if (fixture.rule === "") {
    return hits.length !== 0 || result.mutableBindings !== 0
      ? [`expected clean audit, got ${String(hits.length)} findings`]
      : [];
  }
  const matching = hits.filter((h) => h.rule === fixture.rule);
  if (hits.length !== 1 || matching.length !== 1) {
    return [
      `expected exactly one ${fixture.rule} hit, got ${JSON.stringify(
        hits.map((h) => `${h.rule}@${h.file}:${String(h.line)}`),
      )}`,
    ];
  }
  const hit = matching[0];
  if (hit?.token !== fixture.token) {
    return [`expected token ${JSON.stringify(fixture.token)}, got ${JSON.stringify(hit?.token)}`];
  }
  return [];
}

function runSelfTest(): number {
  let failures = 0;
  for (const fixture of FIXTURE_EXPECTATIONS) {
    for (const err of checkFixture(fixture)) {
      process.stdout.write(`self-test FAIL: ${fixture.name}: ${err}\n`);
      failures += 1;
    }
  }
  const src = auditAndPrint("src", join(PACKAGE_DIR, "src"), "code", [".ts"], ALLOWLIST_PATH);
  if (src.findings.length > 0 || src.mutableBindings > 0) {
    process.stdout.write("self-test FAIL: real src audit not clean\n");
    failures += 1;
  }
  if (failures === 0) {
    process.stdout.write(
      `self-test: PASS (${String(FIXTURE_EXPECTATIONS.length)} fixtures, src clean)\n`,
    );
    return 0;
  }
  process.stdout.write(`self-test: FAIL (${String(failures)} fixture failures)\n`);
  return 1;
}

function checkManifestDeps(manifestPath: string): number {
  if (!existsSync(manifestPath)) {
    process.stdout.write(`finding: package.json:0 [missing-dir] ${manifestPath}\n`);
    return 1;
  }
  if ("dependencies" in (JSON.parse(readFileSync(manifestPath, "utf8")) as object)) {
    process.stdout.write(`finding: package.json:0 [dependencies-key] dependencies\n`);
    return 1;
  }
  return 0;
}

function auditSrcMode(): number {
  const r = auditAndPrint("src", join(PACKAGE_DIR, "src"), "code", [".ts"], ALLOWLIST_PATH);
  // The src/ subtree has no manifest of its own — audit the package manifest
  // for a runtime `dependencies` key (the package must stay dependency-free).
  let failures = checkManifestDeps(join(PACKAGE_DIR, "package.json"));
  if (r.findings.length > 0 || r.mutableBindings > 0) failures += 1;
  return failures;
}

function auditTarballMode(dir: string): number {
  const r = auditAndPrint(
    "tarball",
    join(dir, "package", "dist", "src"),
    "code",
    [".js", ".d.ts"],
    DIST_ALLOWLIST_PATH,
  );
  let failures = checkManifestDeps(join(dir, "package", "package.json"));
  if (r.findings.length > 0 || r.mutableBindings > 0) failures += 1;
  return failures;
}

function auditConsumersMode(): number {
  const consumersDir = join(QUALIFICATION_DIR, "consumers");
  if (!existsSync(consumersDir)) {
    process.stdout.write(`finding: consumers:0 [missing-dir] ${consumersDir}\n`);
    return 1;
  }
  let failures = 0;
  for (const name of readdirSync(consumersDir).sort()) {
    const consumerDir = join(consumersDir, name);
    if (!statSync(consumerDir).isDirectory()) continue;
    const r = auditAndPrint(`consumer:${name}`, consumerDir, "consumer", [], "");
    if (r.findings.length > 0) failures += 1;
  }
  return failures;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(runSelfTest());
  }
  let failures = 0;
  if (args.includes("--src")) failures += auditSrcMode();
  const tarballIdx = args.indexOf("--tarball");
  if (tarballIdx !== -1) {
    const dir = args[tarballIdx + 1];
    if (dir === undefined) {
      process.stdout.write("usage: --tarball <extracted-dir>\n");
      process.exit(2);
    }
    failures += auditTarballMode(dir);
  }
  if (args.includes("--consumers")) failures += auditConsumersMode();
  process.stdout.write(
    failures === 0 ? "closure-audit: PASS\n" : `closure-audit: FAIL (${String(failures)})\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
