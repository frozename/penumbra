import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { type FileContentsResult, runFileContents } from "./file-contents.js";

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

async function scanNotesDir(repoRoot: string, statFile: typeof stat): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const notesDir = join(repoRoot, "docs/notes");
  const glob = new Glob("maestro-continuation-*.md");
  try {
    for await (const path of glob.scan({ cwd: notesDir, onlyFiles: true })) {
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
  const candidates = (await scanNotesDir(repoRoot, input.statFile ?? stat)).sort(
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
    out.result.body === "<binary file omitted>" ||
    (out.result.byte_size > 0 && out.result.body.length === 0)
  ) {
    return { result: null, warnings: [] };
  }
  return { result: out.result, warnings: out.warnings };
}
