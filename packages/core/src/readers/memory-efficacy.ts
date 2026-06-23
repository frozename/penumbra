import type { Database } from "bun:sqlite";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JudgeChatFn } from "../services/judge-chat.js";

import { classifyFindings, type Finding } from "../services/memory-efficacy-classifier.js";

export interface MemoryEfficacyRecent {
  total: number;
  by_class: {
    missed_registration: number;
    recall_miss: number;
    memory_ignored: number;
    not_memory_related: number;
  };
  recent: {
    ts: string;
    finding_text: string;
    classification: string;
    severity: string | null;
    raw_response?: string | null;
  }[];
}

export function getMemoryEfficacyRecent(
  db: Database,
  opts?: { sinceISO?: string; limit?: number; includeRaw?: boolean },
): MemoryEfficacyRecent {
  const since = new Date(
    opts?.sinceISO ?? new Date(Date.now() - 14 * 86_400_000).toISOString(),
  ).toISOString();
  const limit = opts?.limit ?? 20;

  const counts = db
    .query<
      { classification: string; cnt: number },
      [string]
    >(`SELECT classification, COUNT(*) AS cnt FROM memory_efficacy_cache WHERE ts >= ? GROUP BY classification`)
    .all(since);

  const byClass: Record<string, number> = {
    missed_registration: 0,
    recall_miss: 0,
    memory_ignored: 0,
    not_memory_related: 0,
  };
  for (const row of counts) {
    byClass[row.classification] = (byClass[row.classification] ?? 0) + row.cnt;
  }

  const recent = opts?.includeRaw
    ? db
        .query<
          {
            ts: string;
            finding_text: string;
            classification: string;
            severity: string | null;
            raw_response_json: string | null;
          },
          [string, number]
        >(
          `SELECT ts, finding_text, classification, severity, raw_response_json
           FROM memory_efficacy_cache
           WHERE ts >= ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        .all(since, limit)
        .map((row) => ({
          ts: row.ts,
          finding_text: row.finding_text,
          classification: row.classification,
          severity: row.severity,
          raw_response: row.raw_response_json,
        }))
    : db
        .query<
          { ts: string; finding_text: string; classification: string; severity: string | null },
          [string, number]
        >(
          `SELECT ts, finding_text, classification, severity
           FROM memory_efficacy_cache
           WHERE ts >= ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        .all(since, limit);

  return {
    total: Object.values(byClass).reduce((a, b) => a + b, 0),
    by_class: byClass as MemoryEfficacyRecent["by_class"],
    recent,
  };
}

function hashFinding(synthesisPath: string, index: number, text: string): string {
  const input = `${synthesisPath}|${String(index)}|${text}`;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex").slice(0, 32);
}

interface ParsedFinding {
  text: string;
  severity: string | null;
  index: number;
}

// Supports two synthesis formats:
// 1. **High — Title** suffix
// 2. 1. [High] Title suffix
const BOLD_LINE_RE =
  /^\d+\. +\*\*(?:(High|Medium|Low) *[—–-] +)?(\S[^*\n]*?)\*\*(?: +(\S[^\n]*))?$/;
const BRACKET_LINE_RE = /^\d+[.)\]] +\[(High|Medium|Low)\] +(\S.*)$/;

function matchFindingLine(line: string): { text: string; severity: string | null } | null {
  const bold = BOLD_LINE_RE.exec(line);
  if (bold) {
    const head = bold[2] ?? "";
    const tail = bold[3];
    const text = `${head}${tail ? " " + tail : ""}`.trim().slice(0, 200);
    return { text, severity: bold[1] ?? null };
  }
  const bracket = BRACKET_LINE_RE.exec(line);
  if (bracket) {
    return { text: (bracket[2] ?? "").trim().slice(0, 200), severity: bracket[1] ?? null };
  }
  return null;
}

function inferTsFromPath(synthesisPath: string): string {
  const tsMatch = /\/(\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2})\//.exec(synthesisPath);
  const tsRaw = tsMatch?.[1];
  if (!tsRaw) return new Date().toISOString();
  return tsRaw.replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})$/,
    "$1-$2-$3T$4:$5:$6Z",
  );
}

const FINDINGS_SECTION_RE =
  /(?:\*\*)?[ \t]*severity[- ]ranked[ \t]+findings?[ \t]*(?:\*\*[ \t]*)?\n([\s\S]*?)(?=\n\*\*(?:Recommended actions|Skipped\/failed personas|Shared concerns|Contradictions)\*\*[ \t]*\n|\n##|\n#|$)/i;

async function parseFindings(
  synthesisPath: string,
): Promise<{ ts: string; findings: ParsedFinding[] } | null> {
  let content: string;
  try {
    content = await readFile(synthesisPath, "utf8");
  } catch {
    return null;
  }

  const sectionText = FINDINGS_SECTION_RE.exec(content)?.[1];
  if (!sectionText) return null;

  const findings: ParsedFinding[] = [];
  let index = 0;
  for (const line of sectionText.split("\n")) {
    const matched = matchFindingLine(line);
    if (!matched) continue;
    index += 1;
    if (matched.text.length > 0) {
      findings.push({ text: matched.text, severity: matched.severity, index });
    }
  }

  if (findings.length === 0) return null;
  return { ts: inferTsFromPath(synthesisPath), findings };
}

interface ToClassifyEntry {
  findingId: string;
  finding: Finding;
  synthesisPath: string;
  ts: string;
}

const OUTER_BATCH_SIZE = 10;
const OUTER_BATCH_CONCURRENCY = 4;
const DEFAULT_MAX_CACHE_ENTRIES = 10_000;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await worker(item, i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

interface CacheStmts {
  getIdStmt: ReturnType<Database["prepare"]>;
  insertStmt: ReturnType<Database["prepare"]>;
}

function prepareCacheStmts(db: Database): CacheStmts {
  return {
    getIdStmt: db.prepare(`SELECT 1 FROM memory_efficacy_cache WHERE finding_id = ? LIMIT 1`),
    insertStmt: db.prepare(
      `INSERT OR IGNORE INTO memory_efficacy_cache (
        finding_id, synthesis_path, ts, finding_index, finding_text,
        severity, classification, classifier_model, classified_at, raw_response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  };
}

async function listReviewEntries(reviewsDir: string): Promise<string[]> {
  try {
    return (await readdir(reviewsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

interface CollectFindingsResult {
  toClassify: ToClassifyEntry[];
  scanned: number;
  skipped: number;
}

async function collectPendingFindings(
  reviewsDir: string,
  entries: readonly string[],
  sinceCutoff: string,
  getIdStmt: CacheStmts["getIdStmt"],
): Promise<CollectFindingsResult> {
  const toClassify: ToClassifyEntry[] = [];
  let scanned = 0;
  let skipped = 0;
  for (const entry of entries) {
    const dirTs = entry.replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/,
      "$1-$2-$3T$4:$5:$6Z",
    );
    if (dirTs < sinceCutoff) continue;
    const synthesisPath = join(reviewsDir, entry, "synthesis.md");
    const parsed = await parseFindings(synthesisPath);
    if (!parsed) continue;
    scanned += parsed.findings.length;
    for (const finding of parsed.findings) {
      const findingId = hashFinding(synthesisPath, finding.index, finding.text);
      if (getIdStmt.get(findingId)) {
        skipped += 1;
        continue;
      }
      toClassify.push({
        findingId,
        finding: {
          text: finding.text,
          severity: finding.severity,
          index: finding.index,
          findingId,
        },
        synthesisPath,
        ts: parsed.ts,
      });
    }
  }
  return { toClassify, scanned, skipped };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface BatchResult {
  batch: ToClassifyEntry[];
  classifications: Awaited<ReturnType<typeof classifyFindings>>;
}

async function classifyBatches(
  toClassify: readonly ToClassifyEntry[],
  concurrency: number,
  judgeChat: JudgeChatFn,
  model: string,
): Promise<BatchResult[]> {
  const batches = chunk(toClassify, OUTER_BATCH_SIZE);
  return await mapWithConcurrency(batches, concurrency, async (batch): Promise<BatchResult> => {
    const batchFindings = batch.map((e) => ({ ...e.finding, findingId: e.findingId }));
    const classifications = await classifyFindings(batchFindings, { judgeChat, model });
    return { batch, classifications };
  });
}

function persistBatchResults(
  insertStmt: CacheStmts["insertStmt"],
  results: readonly BatchResult[],
  model: string,
  now: string,
): number {
  let classified = 0;
  for (const { batch, classifications } of results) {
    const clsByFindingId = new Map<string, (typeof classifications)[number]>();
    for (const cls of classifications) clsByFindingId.set(cls.findingId, cls);
    for (const [j, entry] of batch.entries()) {
      const cls = clsByFindingId.get(entry.findingId) ?? classifications[j];
      if (!cls) continue;
      insertStmt.run(
        entry.findingId,
        entry.synthesisPath,
        new Date(entry.ts).toISOString(),
        entry.finding.index,
        entry.finding.text.slice(0, 200),
        entry.finding.severity,
        cls.classification,
        model,
        now,
        cls.raw_response_json,
      );
      classified += 1;
    }
  }
  return classified;
}

function resolveConcurrency(requested: number | undefined): number {
  const concurrency = requested ?? OUTER_BATCH_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error(
      `buildMemoryEfficacyCache: concurrency must be integer in [1, 32], got ${String(requested)}`,
    );
  }
  return concurrency;
}

function resolveMaxCacheEntries(requested: number | undefined): number {
  const maxCacheEntries = requested ?? DEFAULT_MAX_CACHE_ENTRIES;
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) {
    throw new Error(
      `buildMemoryEfficacyCache: maxCacheEntries must be a positive integer, got ${String(requested)}`,
    );
  }
  return maxCacheEntries;
}

function pruneMemoryEfficacyCache(db: Database, maxCacheEntries: number): void {
  const row = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_efficacy_cache")
    .get();
  const deleteCount = (row?.count ?? 0) - maxCacheEntries;
  if (deleteCount <= 0) return;

  db.prepare(
    `DELETE FROM memory_efficacy_cache
     WHERE finding_id IN (
       SELECT finding_id
       FROM memory_efficacy_cache
       ORDER BY ts ASC, classified_at ASC, finding_id ASC
       LIMIT ?
     )`,
  ).run(deleteCount);
}

/** Build the memory efficacy cache with batched classification and sequential persistence. */
export async function buildMemoryEfficacyCache(
  db: Database,
  opts: {
    reviewsDir: string;
    judgeChat: JudgeChatFn;
    model: string;
    sinceISO?: string;
    concurrency?: number;
    maxCacheEntries?: number;
  },
): Promise<{ scanned: number; classified: number; skipped: number }> {
  const concurrency = resolveConcurrency(opts.concurrency);
  const maxCacheEntries = resolveMaxCacheEntries(opts.maxCacheEntries);
  const now = new Date().toISOString();
  const sinceCutoff = new Date(opts.sinceISO ?? "1970-01-01T00:00:00Z").toISOString();

  const entries = await listReviewEntries(opts.reviewsDir);
  if (entries.length === 0) {
    pruneMemoryEfficacyCache(db, maxCacheEntries);
    return { scanned: 0, classified: 0, skipped: 0 };
  }

  const { getIdStmt, insertStmt } = prepareCacheStmts(db);
  const { toClassify, scanned, skipped } = await collectPendingFindings(
    opts.reviewsDir,
    entries,
    sinceCutoff,
    getIdStmt,
  );

  const batchResults = await classifyBatches(toClassify, concurrency, opts.judgeChat, opts.model);
  const classified = persistBatchResults(insertStmt, batchResults, opts.model, now);
  pruneMemoryEfficacyCache(db, maxCacheEntries);

  return { scanned, classified, skipped };
}
