import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TranscriptInfo = {
  sessionId: string;
  path: string;
  estimatedTokens: number;
  modifiedAt: Date;
};

export type FindTranscriptOpts = {
  cwd: string;
  claudeProjectsRoot?: string;
  now?: Date;
  staleAfterMin?: number;
};

const TOKENS_PER_CHAR = 0.25;

function dirNameForCwd(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function estimateTokensFromJsonlLine(line: string): number {
  if (!line.trim()) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object") return 0;
  const obj = parsed as { message?: { role?: string; content?: unknown } };
  const role = obj.message?.role;
  if (role !== "user" && role !== "assistant") return 0;
  const content = obj.message?.content;
  if (typeof content === "string") return Math.ceil(content.length * TOKENS_PER_CHAR);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      total += Math.ceil((block as { text: string }).text.length * TOKENS_PER_CHAR);
    }
  }
  return total;
}

function pickNewestJsonl(subdir: string): { path: string; mtimeMs: number } | null {
  let entries: string[];
  try {
    entries = readdirSync(subdir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((e) => e.endsWith(".jsonl"));
  if (jsonl.length === 0) return null;
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const file of jsonl) {
    const full = join(subdir, file);
    try {
      const st = statSync(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = full;
      }
    } catch {
      continue;
    }
  }
  if (!bestPath) return null;
  return { path: bestPath, mtimeMs: bestMtime };
}

type TranscriptCacheEntry = {
  byteOffset: number;
  partialLineRemainder: string;
  cachedTokenTotal: number;
  mtimeMs: number;
};

const transcriptCache = new Map<string, TranscriptCacheEntry>();

export function resetTranscriptReaderCache(): void {
  transcriptCache.clear();
}

function tokenizeCompleteLines(
  chunk: string,
  startTotal: number,
): { total: number; remainder: string } {
  const lines = chunk.split("\n");
  let total = startTotal;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    total += estimateTokensFromJsonlLine(line);
  }
  return { total, remainder: lines[lines.length - 1] ?? "" };
}

function readTranscriptTokens(path: string, mtimeMs: number): number {
  let fileSize: number;
  try {
    fileSize = statSync(path).size;
  } catch {
    return transcriptCache.get(path)?.cachedTokenTotal ?? 0;
  }

  const cached = transcriptCache.get(path);
  const rotated = !cached || fileSize < cached.byteOffset || mtimeMs < cached.mtimeMs;

  if (rotated) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return cached?.cachedTokenTotal ?? 0;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const { total, remainder } = tokenizeCompleteLines(text, 0);
    transcriptCache.set(path, {
      byteOffset: bytes,
      partialLineRemainder: remainder,
      cachedTokenTotal: total,
      mtimeMs,
    });
    return total;
  }

  if (fileSize === cached.byteOffset) {
    if (mtimeMs !== cached.mtimeMs) {
      transcriptCache.set(path, { ...cached, mtimeMs });
    }
    return cached.cachedTokenTotal;
  }

  const bytesToRead = fileSize - cached.byteOffset;
  const buffer = Buffer.alloc(bytesToRead);
  let actuallyRead = 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    actuallyRead = readSync(fd, buffer, 0, bytesToRead, cached.byteOffset);
  } catch {
    return cached.cachedTokenTotal;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  const appended = buffer.subarray(0, actuallyRead).toString("utf8");
  const combined = cached.partialLineRemainder + appended;
  const { total, remainder } = tokenizeCompleteLines(combined, cached.cachedTokenTotal);

  transcriptCache.set(path, {
    byteOffset: cached.byteOffset + actuallyRead,
    partialLineRemainder: remainder,
    cachedTokenTotal: total,
    mtimeMs,
  });
  return total;
}

export function findActiveTranscriptForCwd(opts: FindTranscriptOpts): TranscriptInfo | null {
  const root = opts.claudeProjectsRoot ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  const subdir = join(root, dirNameForCwd(opts.cwd));
  if (!existsSync(subdir)) return null;
  const newest = pickNewestJsonl(subdir);
  if (!newest) return null;
  const bestPath = newest.path;
  const bestMtime = newest.mtimeMs;

  const now = opts.now ?? new Date();
  const stalenessMin = (now.getTime() - bestMtime) / 60_000;
  const limit = opts.staleAfterMin ?? 30;
  if (stalenessMin > limit) return null;

  const sessionId = (bestPath.split("/").pop() ?? "").replace(/\.jsonl$/, "");
  const totalTokens = readTranscriptTokens(bestPath, bestMtime);

  return {
    sessionId,
    path: bestPath,
    estimatedTokens: totalTokens,
    modifiedAt: new Date(bestMtime),
  };
}
