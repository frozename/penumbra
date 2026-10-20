import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  BINARY_BODY_PLACEHOLDER,
  type FileContentsResult,
  runFileContents,
} from "./file-contents.js";

export type LatestContinuationNoteInput = {
  cwd: string;
  repoRoot?: string;
  storageRoot?: string;
  args: Record<string, unknown>;
  statFile?: typeof stat;
};

export type LatestContinuationNoteOutput = {
  result: FileContentsResult | null;
  warnings: string[];
};

type Candidate = { path: string; mtimeMs: number };

function periodKey(path: string): string {
  if (path.endsWith(".skeleton.md")) return path.slice(0, -".skeleton.md".length) + ".md";
  if (path.endsWith(".draft.md")) return path.slice(0, -".draft.md".length) + ".md";
  return path;
}

function pickPerPeriod(candidates: Candidate[]): Candidate[] {
  const winners = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = periodKey(candidate.path);
    const current = winners.get(key);
    if (!current) {
      winners.set(key, candidate);
      continue;
    }
    const currentIsBare = !current.path.endsWith(".skeleton.md");
    const candidateIsBare = !candidate.path.endsWith(".skeleton.md");
    if (candidateIsBare !== currentIsBare) {
      if (candidateIsBare) winners.set(key, candidate);
      continue;
    }
    if (candidate.mtimeMs > current.mtimeMs) winners.set(key, candidate);
  }
  return [...winners.values()];
}

async function scanNotesDir(repoRoot: string, statFile: typeof stat): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const notesDir = join(repoRoot, "docs/notes");
  const glob = new Glob("maestro-continuation-*.md");
  try {
    for await (const path of glob.scan({ cwd: notesDir, onlyFiles: true })) {
      // Unapproved drafts are never candidates; among the rest, a period's bare note beats its .skeleton.md regardless of mtime (pickPerPeriod), then the newest period wins.
      if (path.endsWith(".draft.md")) continue;
      try {
        const info = await statFile(join(notesDir, path));
        if (info.isFile()) out.push({ path: join("docs/notes", path), mtimeMs: info.mtimeMs });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return out;
}

export async function runLatestContinuationNoteSource(
  input: LatestContinuationNoteInput,
): Promise<LatestContinuationNoteOutput> {
  const repoRoot = input.repoRoot ?? input.cwd;
  const candidates = pickPerPeriod(await scanNotesDir(repoRoot, input.statFile ?? stat)).sort(
    (a, b) => b.mtimeMs - a.mtimeMs,
  );
  const newest = candidates[0];
  if (!newest) return { result: null, warnings: [] };

  const out = await runFileContents({
    cwd: repoRoot,
    storageRoot: input.storageRoot,
    args: {
      path: newest.path,
      max_bytes: typeof input.args.max_bytes === "number" ? input.args.max_bytes : undefined,
      allowed_roots: ["docs/notes"],
    },
  });
  if (
    out.result.body === null ||
    out.result.body === BINARY_BODY_PLACEHOLDER ||
    (out.result.byte_size > 0 && out.result.body.length === 0)
  ) {
    return { result: null, warnings: [] };
  }
  return { result: out.result, warnings: out.warnings };
}
