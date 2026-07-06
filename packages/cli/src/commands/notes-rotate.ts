import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const PREFIXES = ["maestro-continuation-", "session-summary-"] as const;
const DEFAULT_KEEP_COUNT = 10;
const SANITY_MIN_KEEP_COUNT = 5;

export interface NotesRotateOpts {
  rootDir: string;
  apply: boolean;
  keepCount?: number;
  now?: Date;
}

export interface NotesRotateItem {
  source: string;
  destination: string;
}

export interface NotesRotateResult {
  dry_run: boolean;
  keep_count: number;
  would_move: NotesRotateItem[];
  moved: NotesRotateItem[];
  skipped_modified: number;
}

function runNotesRotateSync(opts: NotesRotateOpts): NotesRotateResult {
  const keepCount = opts.keepCount ?? DEFAULT_KEEP_COUNT;
  if (keepCount < SANITY_MIN_KEEP_COUNT) {
    throw new Error(`keep-count must be at least ${String(SANITY_MIN_KEEP_COUNT)}`);
  }

  const notesDir = join(opts.rootDir, "docs", "notes");
  const archiveMonth = monthKey(opts.now ?? new Date());
  const candidates = scanCandidates(notesDir);
  const modifiedCount = countModifiedCandidates(
    opts.rootDir,
    candidates.flatMap((group) => group.files.map((name) => join(notesDir, name))),
  );

  if (modifiedCount > 0) {
    throw new Error(
      `refusing — ${String(modifiedCount)} modified files in candidate set; commit or stash first`,
    );
  }

  const wouldMove = candidates
    .flatMap((group) =>
      group.files.slice(keepCount).map((name) => ({
        source: join(notesDir, name),
        destination: join(notesDir, "archive", archiveMonth, name),
      })),
    )
    .sort((a, b) => basename(a.source).localeCompare(basename(b.source)));

  const moved: NotesRotateItem[] = [];
  if (opts.apply) {
    for (const item of wouldMove) {
      mkdirSync(dirname(item.destination), { recursive: true });
      renameSync(item.source, item.destination);
      moved.push(item);
    }
  }

  return {
    dry_run: !opts.apply,
    keep_count: keepCount,
    would_move: wouldMove,
    moved,
    skipped_modified: modifiedCount,
  };
}

export function runNotesRotate(opts: NotesRotateOpts): Promise<NotesRotateResult> {
  try {
    return Promise.resolve(runNotesRotateSync(opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function scanCandidates(notesDir: string): { prefix: string; files: string[] }[] {
  const names = readdirSync(notesDir).filter((name) =>
    PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  const grouped = new Map<string, string[]>();
  for (const prefix of PREFIXES) grouped.set(prefix, []);

  for (const name of names) {
    const prefix = PREFIXES.find((candidate) => name.startsWith(candidate));
    if (!prefix) continue;
    const bucket = grouped.get(prefix);
    if (bucket) bucket.push(name);
  }

  return PREFIXES.map((prefix) => ({
    prefix,
    files: (grouped.get(prefix) ?? []).sort((a, b) => b.localeCompare(a)),
  }));
}

function countModifiedCandidates(rootDir: string, relativeFiles: string[]): number {
  const gitDir = join(rootDir, ".git");
  if (!existsLike(gitDir)) return 0;

  const proc = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain", "--untracked-files=no", "--", ...relativeFiles],
    cwd: rootDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(
      `git status failed while checking candidate files (exit ${String(proc.exitCode)}): ${stderr}`,
    );
  }

  const text = new TextDecoder().decode(proc.stdout);
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.length >= 2 && !line.startsWith("?")).length;
}

function existsLike(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function monthKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${String(year)}-${month}`;
}
