#!/usr/bin/env bun
import { join, resolve } from "node:path";

import { readArgs, scanRepo, type Finding } from "./_scan.js";

const ROOT = resolve(process.env.PENUMBRA_LINT_NO_RAW_ENV_ROOT ?? join(import.meta.dir, "../.."));
const STRICT = process.env.PENUMBRA_LINT_NO_RAW_ENV_STRICT === "1";
const DEFAULT_PATHS = ["packages/**/*.ts"];
const ALLOWLIST = ["packages/config/**"];
const PATTERNS = [/\bprocess\.env\.PENUMBRA_[A-Z0-9_]+\b/g, /\bBun\.env\.PENUMBRA_[A-Z0-9_]+\b/g];

function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
  const expanded = escaped.replace(/\*\*\/|\*\*|\*/g, (token) => {
    if (token === "**/") return "(?:.*\\/)?";
    if (token === "**") return ".*";
    return "[^/]*";
  });
  return new RegExp(`^${expanded}$`).test(path);
}

function isAllowed(path: string): boolean {
  return ALLOWLIST.some((glob) => matchesGlob(path, glob));
}

function scanLine(line: string, lineIdx: number, normalized: string, findings: Finding[]): void {
  for (const matchPattern of PATTERNS) {
    matchPattern.lastIndex = 0;
    const match = matchPattern.exec(line);
    if (match?.[0]) {
      findings.push({ file: normalized, line: lineIdx + 1, match: match[0] });
    }
  }
}

function shouldSkip(normalized: string): boolean {
  if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) {
    return true;
  }
  return isAllowed(normalized);
}

function main(): void {
  const paths = readArgs(process.argv.slice(2), {
    defaultPaths: DEFAULT_PATHS,
    extraFlags: ["--strict"],
  });
  const findings = scanRepo({ root: ROOT, patterns: paths, shouldSkip, scanLine });

  if (findings.length === 0) {
    process.stdout.write("no raw PENUMBRA env reads found\n");
    process.exit(0);
  }

  for (const finding of findings) {
    console.error(`${finding.file}:${String(finding.line)} ${finding.match}`);
  }

  if (STRICT) {
    process.exit(1);
  }

  console.error(
    `warn: found ${String(findings.length)} raw PENUMBRA env read${findings.length === 1 ? "" : "s"}; set PENUMBRA_LINT_NO_RAW_ENV_STRICT=1 to fail`,
  );
  process.exit(0);
}

main();
