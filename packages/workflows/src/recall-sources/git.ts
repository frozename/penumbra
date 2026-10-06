import { execFile as execFileCb } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type GitSourceInput = {
  cwd: string;
  args: { range?: string; since?: string; format?: string; pathspec?: string };
};

export type GitSourceOutput = { text: string; warnings: string[] };

export type GitDiffDeps = {
  rediffBinaryAsText?: (pathspecs: string[]) => Promise<string | null>;
  blobSizes?: (cwd: string, oids: string[]) => Promise<Map<string, number>>;
};
export type GitShowInput = {
  cwd: string;
  args: { range?: string; since?: string; max_commits?: number };
};
export type GitShowOutput = {
  commits: { sha: string; subject: string; body: string; ts: string }[];
  warnings: string[];
};

const REF_TOKEN_RE = /^[A-Za-z0-9._/^~-]{1,200}$/;

function hasForbiddenRefChars(value: string): boolean {
  return value.includes("\0") || value.includes("\n") || value.includes("\r");
}

function isValidGitRefToken(token: string): boolean {
  if (token.length === 0 || token.length > 200) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("../")) return false;
  if (token.includes("..")) return false;
  if (hasForbiddenRefChars(token)) return false;
  return REF_TOKEN_RE.test(token);
}

export function isValidGitRef(ref: string): boolean {
  const value = ref.trim();
  if (value.length === 0) return false;
  if (value.startsWith("--")) return false;
  if (hasForbiddenRefChars(value)) return false;

  const tripleIdx = value.indexOf("...");
  if (tripleIdx !== -1) {
    if (tripleIdx !== value.lastIndexOf("...")) return false;
    const left = value.slice(0, tripleIdx);
    const right = value.slice(tripleIdx + 3);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  const doubleIdx = value.indexOf("..");
  if (doubleIdx !== -1) {
    if (doubleIdx !== value.lastIndexOf("..")) return false;
    const left = value.slice(0, doubleIdx);
    const right = value.slice(doubleIdx + 2);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  return isValidGitRefToken(value);
}

function isValidGitSince(since: string): boolean {
  const value = since.trim();
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith("-")) return false;
  if (hasForbiddenRefChars(value)) return false;
  return true;
}

function isValidGitPathspec(pathspec: string): boolean {
  const value = pathspec.trim();
  if (value.length === 0) return false;
  if (value.startsWith("-")) return false;
  if (hasForbiddenRefChars(value)) return false;
  return true;
}

function isValidGitFormat(format: string): boolean {
  if (format.length === 0) return false;
  if (hasForbiddenRefChars(format)) return false;
  if (format.includes("%x00")) return false;
  if (format.includes("%(")) return false;
  return true;
}

function hasInvalidGitInput(args: {
  range?: string;
  since?: string;
  pathspec?: string;
  format?: string;
}): boolean {
  if (args.range !== undefined && !isValidGitRef(args.range)) return true;
  if (args.since !== undefined && !isValidGitSince(args.since)) return true;
  if (args.pathspec !== undefined && !isValidGitPathspec(args.pathspec)) return true;
  return false;
}

function escapeNulChars(text: string): { text: string; escaped: number } {
  const parts = text.split("\0");
  if (parts.length === 1) return { text, escaped: 0 };
  return { text: parts.join("\\0"), escaped: parts.length - 1 };
}

const BINARY_MARKER_RE = /^Binary files .+ and .+ differ$/m;
const MAX_BINARY_TEXT_RATIO = 0.01;
const MAX_BINARY_REDIFF_BLOB_BYTES = 1024 * 1024;
const MAX_BINARY_REDIFFS = 64;
const BINARY_REDIFF_CONCURRENCY = 4;
const BINARY_SIZE_BATCH_OIDS = 256;
const ZERO_OID_RE = /^0+$/;

function firstLineOf(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

function isTextWithSparseNuls(text: string): boolean {
  if (text.length === 0) return false;
  let nulCount = 0;
  let replacementCount = 0;
  for (const ch of text) {
    if (ch === "\0") nulCount += 1;
    else if (ch === "\uFFFD") replacementCount += 1;
  }
  const budget = text.length * MAX_BINARY_TEXT_RATIO;
  return nulCount <= budget && replacementCount < budget;
}

function splitGitDiffSections(diff: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

type RawDiffEntry = {
  oldOid: string;
  newOid: string;
  status: string;
  srcPath: string;
  dstPath: string;
};

// `git diff --raw -z` emits one NUL-terminated field sequence per filepair:
// ":<oldmode> <newmode> <oldoid> <newoid> <status>" then the path (two paths,
// source then destination, for renames and copies). The entry order matches
// the patch's `diff --git` section order.
function parseRawEntry(
  fields: string[],
  start: number,
): { entry: RawDiffEntry; next: number } | null {
  const header = fields[start] ?? "";
  if (!header.startsWith(":")) return null;
  const cols = header.slice(1).split(" ");
  if (cols.length !== 5) return null;
  const [, , oldOid = "", newOid = "", status = ""] = cols;
  if (!/^[0-9a-f]+$/i.test(oldOid) || !/^[0-9a-f]+$/i.test(newOid)) return null;
  const srcPath = fields[start + 1] ?? "";
  if (srcPath.length === 0) return null;
  let next = start + 2;
  let dstPath = srcPath;
  if (status.startsWith("R") || status.startsWith("C")) {
    dstPath = fields[next] ?? "";
    if (dstPath.length === 0) return null;
    next += 1;
  }
  return { entry: { oldOid, newOid, status, srcPath, dstPath }, next };
}

function parseRawDiffEntries(raw: string): RawDiffEntry[] | null {
  const fields = raw.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  const entries: RawDiffEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const parsed = parseRawEntry(fields, i);
    if (parsed === null) return null;
    entries.push(parsed.entry);
    i = parsed.next;
  }
  return entries;
}

export async function gitBlobSizes(cwd: string, oids: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const unique = [...new Set(oids)].filter((oid) => oid.length > 0 && !ZERO_OID_RE.test(oid));
  if (unique.length === 0) return sizes;
  try {
    const proc = Bun.spawn({
      cmd: ["git", "-C", cwd, "cat-file", "--batch-check", "--buffer"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    // write()/end() return a Promise when the sink buffers the payload; if
    // cat-file exits before draining stdin they reject with EPIPE. Observe them
    // inside the try so a dead pipe resolves as an empty map instead of an
    // unhandledRejection that trips the daemon's crash guard.
    const stdinDone = (async (): Promise<void> => {
      try {
        await proc.stdin.write(`${unique.join("\n")}\n`);
        await proc.stdin.end();
      } catch {
        // Dead pipe: whatever stdout produced before the exit is parsed below.
      }
    })();
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited, stdinDone]);
    // One output line per input oid, in input order: "<oid> <type> <size>" or
    // "<oid> missing". Zip rather than re-keying so abbreviated oids still join.
    const lines = out.split("\n");
    for (const [index, oid] of unique.entries()) {
      const match = / \S+ (\d+)$/.exec(lines[index] ?? "");
      if (match) sizes.set(oid, Number(match[1]));
    }
  } catch {
    // batch-check unavailable: every side resolves as unknown and markers stay.
  }
  return sizes;
}

async function resolveRepoToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", [
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
    ]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type BinaryRediffCandidate = {
  index: number;
  pathspecs: string[];
  entry: RawDiffEntry;
};

// A --text re-diff materializes both blobs in one subprocess buffer (a 64 MB
// pipe per file was enough to push a 400-binary diff past 1.4 GB RSS). Gate on
// measured blob sizes first, then run survivors under a small worker pool with
// a hard count cap; anything excluded keeps git's one-line binary marker.
async function listRawDiffEntries(
  cwd: string,
  baseArgs: string[],
  inputPathspec?: string,
): Promise<RawDiffEntry[] | null> {
  try {
    const { stdout } = await execFile(
      "git",
      [...baseArgs, "--raw", "-z", ...(inputPathspec ? ["--", inputPathspec] : [])],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return parseRawDiffEntries(stdout);
  } catch {
    return null;
  }
}

// Candidates are sized in index order, at most BINARY_SIZE_BATCH_OIDS per
// cat-file call: the sizing pass itself is what pinned hundreds of MB of
// native memory on diffs with thousands of markers, so it must stop as soon
// as the re-diff cap is filled instead of sizing every marker first.
function takeOidBatch(
  candidates: BinaryRediffCandidate[],
  start: number,
): { batch: BinaryRediffCandidate[]; oids: string[]; next: number } {
  const batch: BinaryRediffCandidate[] = [];
  const batchOids = new Set<string>();
  let next = start;
  while (next < candidates.length) {
    const candidate = candidates[next];
    if (candidate === undefined) break;
    const extra = [candidate.entry.oldOid, candidate.entry.newOid].filter(
      (oid) => oid.length > 0 && !ZERO_OID_RE.test(oid) && !batchOids.has(oid),
    );
    if (batch.length > 0 && batchOids.size + extra.length > BINARY_SIZE_BATCH_OIDS) break;
    for (const oid of extra) batchOids.add(oid);
    batch.push(candidate);
    next += 1;
  }
  return { batch, oids: [...batchOids], next };
}

type EligibleRediffScan = {
  eligible: BinaryRediffCandidate[];
  keptByCap: number;
};

async function eligibleRediffCandidates(
  cwd: string,
  candidates: BinaryRediffCandidate[],
  blobSizes: (cwd: string, oids: string[]) => Promise<Map<string, number>>,
): Promise<EligibleRediffScan> {
  let toplevel: string | null | undefined;
  const worktreeSize = async (path: string): Promise<number | null> => {
    // A zero oid on a non-add/delete side means content only exists in the
    // worktree (unstaged `git diff` / `git diff <rev>`); measure the file.
    if (toplevel === undefined) toplevel = await resolveRepoToplevel(cwd);
    if (toplevel === null) return null;
    try {
      return (await stat(join(toplevel, path))).size;
    } catch {
      return null;
    }
  };
  const sideSize = async (
    oid: string,
    role: "old" | "new",
    entry: RawDiffEntry,
    sizes: Map<string, number>,
  ): Promise<number | null> => {
    if (!ZERO_OID_RE.test(oid)) return sizes.get(oid) ?? null;
    if (role === "old" && entry.status.startsWith("A")) return 0;
    if (role === "new" && entry.status.startsWith("D")) return 0;
    return await worktreeSize(role === "new" ? entry.dstPath : entry.srcPath);
  };
  const oversized = (size: number | null): boolean =>
    size === null || size > MAX_BINARY_REDIFF_BLOB_BYTES;

  const eligible: BinaryRediffCandidate[] = [];
  let rejected = 0;
  let start = 0;
  while (start < candidates.length && eligible.length < MAX_BINARY_REDIFFS) {
    const { batch, oids, next } = takeOidBatch(candidates, start);
    const sizes = await blobSizes(cwd, oids);
    for (const candidate of batch) {
      const { entry } = candidate;
      const [oldSize, newSize] = await Promise.all([
        sideSize(entry.oldOid, "old", entry, sizes),
        sideSize(entry.newOid, "new", entry, sizes),
      ]);
      if (oversized(oldSize) || oversized(newSize)) rejected += 1;
      else if (eligible.length < MAX_BINARY_REDIFFS) eligible.push(candidate);
    }
    start = next;
  }
  return { eligible, keptByCap: candidates.length - rejected - eligible.length };
}

// Marker lines C-quote non-ASCII names and split ambiguously on " and ", and
// plain pathspecs glob `d[1].txt` into `d1.txt`. The raw listing gives the
// root-relative path verbatim; `:(top,literal)` pins it literally from any cwd.
// Renames and copies need both sides: the pair matches the pathspec on either
// path, and the re-diffed section header must name the same filepair as the
// marker it would replace.
function collectBinaryCandidates(
  sections: string[],
  markerIndexes: number[],
  entries: RawDiffEntry[],
): BinaryRediffCandidate[] {
  const candidates: BinaryRediffCandidate[] = [];
  for (const index of markerIndexes) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const pathspecs =
      entry.status.startsWith("R") || entry.status.startsWith("C")
        ? [`:(top,literal)${entry.srcPath}`, `:(top,literal)${entry.dstPath}`]
        : [`:(top,literal)${entry.dstPath}`];
    candidates.push({ index, pathspecs, entry });
  }
  return candidates;
}

// A --text re-diff materializes both blobs in one subprocess buffer (a 64 MB
// pipe per file was enough to push a 400-binary diff past 1.4 GB RSS). Gate on
// measured blob sizes first, then run survivors under a small worker pool with
// a hard count cap; anything excluded keeps git's one-line binary marker.
async function rediffBinaryMarkers(opts: {
  cwd: string;
  baseArgs: string[];
  inputPathspec?: string;
  sections: string[];
  warnings: string[];
  rediff: (pathspecs: string[]) => Promise<string | null>;
  blobSizes?: (cwd: string, oids: string[]) => Promise<Map<string, number>>;
}): Promise<void> {
  const { cwd, baseArgs, inputPathspec, sections, warnings, rediff, blobSizes } = opts;
  const markerIndexes = sections.flatMap((section, index) =>
    BINARY_MARKER_RE.test(section) ? [index] : [],
  );
  if (markerIndexes.length === 0) return;

  const entries = await listRawDiffEntries(cwd, baseArgs, inputPathspec);
  if (entries === null) {
    warnings.push("git.diff: binary re-diff skipped (raw file listing unavailable)");
    return;
  }
  if (entries.length !== sections.length) {
    warnings.push(
      `git.diff: binary re-diff skipped (raw listing ${String(entries.length)} entries did not align with ${String(sections.length)} patch sections; binary markers kept)`,
    );
    return;
  }

  const candidates = collectBinaryCandidates(sections, markerIndexes, entries);
  if (candidates.length === 0) return;

  const { eligible, keptByCap } = await eligibleRediffCandidates(
    cwd,
    candidates,
    blobSizes ?? gitBlobSizes,
  );
  if (keptByCap > 0) {
    warnings.push(
      `git.diff: ${String(keptByCap)} binary file(s) kept as markers (re-diff cap ${String(MAX_BINARY_REDIFFS)})`,
    );
  }
  const results = await mapWithConcurrency(
    eligible,
    BINARY_REDIFF_CONCURRENCY,
    async (candidate) => {
      let text: string | null = null;
      try {
        text = await rediff(candidate.pathspecs);
      } catch {
        text = null;
      }
      // Classify inside the worker so binary bodies are released as soon as each
      // re-diff finishes instead of all being held until the pool drains.
      // Typechanges, submodule bumps and unmerged paths can shift raw entries
      // off their patch sections without changing the totals; a shifted entry
      // re-diffs the WRONG file, so only replace the marker when the re-diff
      // names the same filepair as the marker section's own header.
      return {
        index: candidate.index,
        text:
          text !== null &&
          isTextWithSparseNuls(text) &&
          firstLineOf(text) === firstLineOf(sections[candidate.index] ?? "")
            ? text
            : null,
      };
    },
  );
  for (const { index, text } of results) {
    if (text !== null) sections[index] = text;
  }
}

function truncateBody(body: string, maxChars = 2000): string {
  if (body.length <= maxChars) return body;
  let trimmed = body.slice(0, maxChars);
  if (!trimmed.endsWith("\n")) trimmed += "\n";
  return `${trimmed}[…truncated]\n`;
}

export async function runGitLog(input: GitSourceInput): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  if (hasInvalidGitInput(args)) {
    return { text: "", warnings: ["git.log: invalid ref"] };
  }
  if (args.format !== undefined && !isValidGitFormat(args.format)) {
    return { text: "", warnings: ["git.log: invalid format"] };
  }
  const fmt = args.format ?? "%h %s";
  const gitArgs = ["-C", cwd, "log", `--pretty=format:${fmt}`];
  if (args.range) {
    gitArgs.push(args.range);
  } else if (args.since) {
    gitArgs.push(`--since=${args.since}`);
  }
  if (args.pathspec) {
    gitArgs.push("--", args.pathspec);
  }
  try {
    const { stdout } = await execFile("git", gitArgs);
    return { text: stdout, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: "", warnings: [`git.log: ${msg}`] };
  }
}

export async function runGitDiff(
  input: GitSourceInput,
  deps: GitDiffDeps = {},
): Promise<GitSourceOutput> {
  const { cwd, args } = input;
  if (hasInvalidGitInput(args)) {
    return { text: "", warnings: ["git.diff: invalid ref"] };
  }
  const gitArgs = ["-C", cwd, "diff"];
  if (args.range) gitArgs.push(args.range);
  try {
    const { stdout } = await execFile(
      "git",
      args.pathspec ? [...gitArgs, "--", args.pathspec] : gitArgs,
      { maxBuffer: 64 * 1024 * 1024 },
    );
    // Run without --text so binary files collapse to a one-line marker instead
    // of hundreds of KB of mojibake that would consume the recall budget. Each
    // marked path is then re-diffed alone with --text: files that are really
    // text carrying sparse NULs (fixtures, logs) still render as hunks, while
    // dense binary stays a marker.
    const sections = splitGitDiffSections(stdout);
    const warnings: string[] = [];
    const rediff =
      deps.rediffBinaryAsText ??
      (async (pathspecs: string[]): Promise<string | null> => {
        try {
          const { stdout: fileDiff } = await execFile(
            "git",
            [...gitArgs, "--text", "--", ...pathspecs],
            { maxBuffer: 4 * 1024 * 1024 },
          );
          return fileDiff;
        } catch {
          return null;
        }
      });
    await rediffBinaryMarkers({
      cwd,
      baseArgs: gitArgs,
      inputPathspec: args.pathspec,
      sections,
      warnings,
      rediff,
      blobSizes: deps.blobSizes,
    });
    const { text, escaped } = escapeNulChars(sections.join("\n"));
    if (escaped > 0) warnings.push(`git.diff: ${String(escaped)} NUL bytes escaped`);
    return { text, warnings };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: "", warnings: [`git.diff: ${msg}`] };
  }
}

export async function runGitShow(input: GitShowInput): Promise<GitShowOutput> {
  const { cwd, args } = input;
  if (hasInvalidGitInput(args)) {
    return { commits: [], warnings: ["git.show: invalid ref"] };
  }
  const maxCommits = args.max_commits ?? 50;
  const gitArgs = [
    "-C",
    cwd,
    "log",
    "--pretty=format:%H%x00%s%x00%aI%x00%b%x1e",
    "-n",
    String(maxCommits),
  ];
  if (args.range) {
    gitArgs.push(args.range);
  } else if (args.since) {
    gitArgs.push(`--since=${args.since}`);
  }
  try {
    const { stdout } = await execFile("git", gitArgs);
    const commits: GitShowOutput["commits"] = [];
    for (const record of stdout.split("\x1e")) {
      if (record.length === 0) continue;
      const [sha = "", subject = "", ts = "", body = ""] = record.replace(/^\n+/, "").split("\x00");
      if (sha.length === 0) continue;
      commits.push({ sha, subject, ts, body: truncateBody(body) });
    }
    return { commits, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { commits: [], warnings: [`git.show: ${msg}`] };
  }
}
