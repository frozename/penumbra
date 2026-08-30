import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Finding = {
  file: string;
  line: number;
  match: string;
};

export function readArgs(
  argv: string[],
  opts: { defaultPaths: string[]; extraFlags?: string[] },
): string[] {
  const paths: string[] = [];
  const extraFlags = new Set(opts.extraFlags ?? []);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--paths") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--paths requires a glob");
      }
      paths.push(value);
      continue;
    }
    if (extraFlags.has(arg)) {
      continue;
    }
    throw new Error(`unknown arg: ${String(arg)}`);
  }
  return paths.length ? paths : opts.defaultPaths;
}

export function scanRepo(opts: {
  root: string;
  patterns: string[];
  shouldSkip: (normalized: string) => boolean;
  scanLine: (line: string, lineIdx: number, normalized: string, findings: Finding[]) => void;
}): Finding[] {
  const findings: Finding[] = [];
  for (const pattern of opts.patterns) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: opts.root, onlyFiles: true })) {
      const normalized = rel.split("\\").join("/");
      if (opts.shouldSkip(normalized)) {
        continue;
      }
      const lines = readFileSync(join(opts.root, rel), "utf8").split(/\r?\n/);
      for (const [lineIdx, line] of lines.entries()) {
        opts.scanLine(line, lineIdx, normalized, findings);
      }
    }
  }
  return findings;
}
