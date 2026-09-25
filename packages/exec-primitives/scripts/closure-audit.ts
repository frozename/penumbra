/**
 * closure-audit.ts — static boundary audit for the exec-primitives package.
 *
 * Scans TypeScript sources and reports:
 *   - file/line/byte counts (the numbers the evidence JSON copies)
 *   - import specifiers, classified runtime vs type-only
 *   - mutable module-scope bindings (top-level let/var) — must be zero
 *   - forbidden host-environment touchpoints after comment stripping
 *     (console.*, process.env, process.stdout/stderr writes, require/eval)
 *
 * Usage:
 *   bun scripts/closure-audit.ts --src          # audit ./src relative to package root
 *   bun scripts/closure-audit.ts --dir <path>   # audit an arbitrary directory
 *
 * Exit 0 when the audit is clean; exit 1 listing violations otherwise.
 * The counts block is printed as JSON so callers/tests can copy it verbatim.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const PACKAGE_DIR = dirname(import.meta.dir);

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const FORBIDDEN_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "console", re: /\bconsole\.(log|warn|error|info|debug|trace)\b/ },
  { rule: "process-env", re: /\bprocess\.env\b/ },
  { rule: "process-stdout-write", re: /\bprocess\.stdout\.write\b/ },
  { rule: "process-stderr-write", re: /\bprocess\.stderr\.write\b/ },
  { rule: "commonjs-require", re: /(?:^|[^.\w])require\s*\(/ },
  { rule: "eval", re: /\beval\s*\(/ },
  { rule: "function-ctor", re: /\bnew\s+Function\s*\(/ },
  { rule: "penumbra-env", re: /\bPENUMBRA_[A-Z_]+\b/ },
  { rule: "penumbra-home", re: /\.penumbra\b/ },
];

const ALLOWED_SPECIFIER = /^(?:node:|\.\.?\/)/;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...collectTsFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

function stripComments(source: string): string {
  // Replace comment bodies with spaces so line numbers and string literals survive.
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (m) => m.replaceAll(/[^\n]/g, " "))
    .replaceAll(/(?<!:)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

interface ImportRecord {
  specifier: string;
  typeOnly: boolean;
  file: string;
  line: number;
}

function extractImports(source: string, rel: string): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const stmtRe = /\bimport[\s'"][\s\S]*?;/g;
  for (const m of source.matchAll(stmtRe)) {
    const stmt = m[0];
    const spec =
      /from\s*["']([^"'\n]+)["']/.exec(stmt)?.[1] ?? /import\s*["']([^"'\n]+)["']/.exec(stmt)?.[1];
    if (spec === undefined) continue;
    imports.push({
      specifier: spec,
      typeOnly: /\bimport\s+type[\s{]/.test(stmt),
      file: rel,
      line: source.slice(0, m.index).split("\n").length,
    });
  }
  return imports;
}

function scanFile(
  path: string,
  root: string,
): {
  lines: number;
  bytes: number;
  imports: ImportRecord[];
  mutableBindings: number;
  findings: Finding[];
} {
  const rel = relative(root, path);
  const source = readFileSync(path, "utf8");
  const stripped = stripComments(source);
  const imports = extractImports(source, rel);
  const findings: Finding[] = [];
  let mutableBindings = 0;

  for (const imp of imports) {
    if (!ALLOWED_SPECIFIER.test(imp.specifier)) {
      findings.push({
        file: imp.file,
        line: imp.line,
        rule: "bare-specifier",
        text: imp.specifier,
      });
    }
  }

  const lines = stripped.split("\n");
  for (const [i, line] of lines.entries()) {
    if (/^(?:export\s+)?(?:let|var)\s/.test(line)) mutableBindings += 1;
    for (const { rule, re } of FORBIDDEN_PATTERNS) {
      if (re.test(line)) {
        findings.push({ file: rel, line: i + 1, rule, text: line.trim() });
      }
    }
  }

  return {
    lines: source.split("\n").length - 1,
    bytes: Buffer.byteLength(source, "utf8"),
    imports,
    mutableBindings,
    findings,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  let targetDir: string;
  if (args.includes("--src")) {
    targetDir = join(PACKAGE_DIR, "src");
  } else {
    const idx = args.indexOf("--dir");
    const dirArg = idx === -1 ? undefined : args[idx + 1];
    if (dirArg === undefined) {
      console.error("usage: closure-audit.ts --src | --dir <path>");
      process.exit(2);
    }
    targetDir = dirArg;
  }

  const files = collectTsFiles(targetDir);
  let lines = 0;
  let bytes = 0;
  let mutableBindings = 0;
  const imports: ImportRecord[] = [];
  const findings: Finding[] = [];
  for (const file of files) {
    const r = scanFile(file, targetDir);
    lines += r.lines;
    bytes += r.bytes;
    mutableBindings += r.mutableBindings;
    imports.push(...r.imports);
    findings.push(...r.findings);
  }

  const runtimeImports = imports.filter((i) => !i.typeOnly);
  const typeOnlyImports = imports.filter((i) => i.typeOnly);

  const counts = {
    files: files.length,
    lines,
    bytes,
    specifiers: imports.length,
    runtimeSpecifiers: runtimeImports.length,
    typeOnlySpecifiers: typeOnlyImports.length,
    mutableBindings,
    violations: findings.length,
  };
  const emit = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  emit(`counts: ${JSON.stringify(counts)}`);
  for (const imp of imports) {
    emit(
      `import: ${imp.typeOnly ? "type" : "runtime"} ${imp.specifier} (${imp.file}:${String(imp.line)})`,
    );
  }
  for (const f of findings) {
    emit(`violation: ${f.file}:${String(f.line)} [${f.rule}] ${f.text}`);
  }

  if (findings.length > 0 || mutableBindings > 0) {
    emit("closure-audit: FAIL");
    process.exit(1);
  }
  emit("closure-audit: PASS");
}

main();
