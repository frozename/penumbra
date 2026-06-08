#!/usr/bin/env bun
// Lints packages/daemon/src for synchronous subprocess calls.
// Escape hatch: `// lint-ignore: no-sync-exec <reason>` on the offending line.
import { readFileSync } from "fs";
import { join, resolve } from "path";

type Finding = {
  file: string;
  line: number;
  match: string;
};

const ROOT = resolve(process.env.PENUMBRA_LINT_NO_SYNC_EXEC_ROOT ?? join(import.meta.dir, "../.."));
const DEFAULT_PATHS = ["packages/daemon/src/**/*.ts"];
const PATTERNS = [
  /\bBun\.spawnSync\b/g,
  /\bexecSync\b/g,
  /\bspawnSync\b/g,
  /\bimport\s+.*from\s+["']child_process["']/g,
];

function readArgs(argv: string[]) {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--paths") {
      const value = argv[++i];
      if (!value) throw new Error("--paths requires a glob");
      paths.push(value);
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  return paths.length ? paths : DEFAULT_PATHS;
}

function scan(paths: string[]) {
  const findings: Finding[] = [];
  for (const pattern of paths) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
      const normalized = rel.split("\\").join("/");
      if (!normalized.startsWith("packages/daemon/src/")) continue;
      if (!normalized.endsWith(".ts") || normalized.endsWith(".test.ts")) continue;

      const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]!;
        const code = line.split("//", 1)[0]!;
        if (line.includes("// lint-ignore: no-sync-exec")) continue;
        for (const pattern of PATTERNS) {
          pattern.lastIndex = 0;
          const match = pattern.exec(code);
          if (match?.[0]) {
            findings.push({ file: normalized, line: lineIdx + 1, match: match[0] });
          }
        }
      }
    }
  }
  return findings;
}

function main() {
  const paths = readArgs(process.argv.slice(2));
  const findings = scan(paths);

  if (findings.length === 0) {
    process.stdout.write("no sync exec violations found\n");
    process.exit(0);
  }

  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.match}`);
  }
  process.exit(1);
}

main();
