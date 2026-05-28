#!/usr/bin/env bun
import { readFileSync } from "fs";
import { join, resolve } from "path";

type Finding = {
  file: string;
  line: number;
  match: string;
};

const ROOT = resolve(process.env.PENUMBRA_LINT_NO_RAW_ENV_ROOT ?? join(import.meta.dir, "../.."));
const STRICT = process.env.PENUMBRA_LINT_NO_RAW_ENV_STRICT === "1";
const DEFAULT_PATHS = ["packages/**/*.ts"];
const ALLOWLIST = ["packages/config/**"];
const PATTERNS = [/\bprocess\.env\.PENUMBRA_[A-Z0-9_]+\b/g, /\bBun\.env\.PENUMBRA_[A-Z0-9_]+\b/g];

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
    if (arg === "--strict") continue;
    throw new Error(`unknown arg: ${arg}`);
  }
  return paths.length ? paths : DEFAULT_PATHS;
}

function matchesGlob(path: string, glob: string) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "(?:.*\\/)?")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isAllowed(path: string) {
  return ALLOWLIST.some((glob) => matchesGlob(path, glob));
}

function scan(paths: string[]) {
  const findings: Finding[] = [];

  for (const pattern of paths) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
      const normalized = rel.split("\\").join("/");
      if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) continue;
      if (isAllowed(normalized)) continue;

      const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]!;
        for (const pattern of PATTERNS) {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
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
    process.stdout.write("no raw PENUMBRA env reads found\n");
    process.exit(0);
  }

  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.match}`);
  }

  if (STRICT) {
    process.exit(1);
  }

  console.error(
    `warn: found ${findings.length} raw PENUMBRA env read${findings.length === 1 ? "" : "s"}; set PENUMBRA_LINT_NO_RAW_ENV_STRICT=1 to fail`,
  );
  process.exit(0);
}

main();
