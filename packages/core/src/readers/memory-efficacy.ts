import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiriusChatFn } from '../services/sirius-chat.js';
import { type Finding, classifyFindings } from '../services/memory-efficacy-classifier.js';

export interface MemoryEfficacyRecent {
  total: number;
  by_class: {
    missed_registration: number;
    recall_miss: number;
    memory_ignored: number;
    not_memory_related: number;
  };
  recent: Array<{
    ts: string;
    finding_text: string;
    classification: string;
    severity: string | null;
    raw_response?: string | null;
  }>;
}

export function getMemoryEfficacyRecent(
  db: Database,
  opts?: { sinceISO?: string; limit?: number; includeRaw?: boolean },
): MemoryEfficacyRecent {
  const since = new Date(opts?.sinceISO ?? new Date(Date.now() - 14 * 86_400_000).toISOString()).toISOString();
  const limit = opts?.limit ?? 20;

  const counts = db
    .query<
      { classification: string; cnt: number },
      [string]
    >(
      `SELECT classification, COUNT(*) AS cnt FROM memory_efficacy_cache WHERE ts >= ? GROUP BY classification`,
    )
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
          { ts: string; finding_text: string; classification: string; severity: string | null; raw_response_json: string | null },
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
    by_class: byClass as MemoryEfficacyRecent['by_class'],
    recent,
  };
}

function hashFinding(synthesisPath: string, index: number, text: string): string {
  const input = `${synthesisPath}|${index}|${text}`;
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex').slice(0, 32);
}

function parseFindings(synthesisPath: string): { ts: string; findings: Finding[] } | null {
  let content: string;
  try {
    content = readFileSync(synthesisPath, 'utf8');
  } catch {
    return null;
  }

  const tsMatch = synthesisPath.match(/\/(\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2})\//);
  const ts = tsMatch
    ? tsMatch[1]!.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})$/, '$1-$2-$3T$4:$5:$6Z')
    : new Date().toISOString();

  const findingsSection = content.match(
    /severity[- ]ranked\s+findings?\s*\n([\s\S]*?)(?=\n##|\n#|$)/i,
  );
  if (!findingsSection) return null;

  const sectionText = findingsSection[1]!;
  const lines = sectionText.split('\n');

  const findings: Finding[] = [];
  let index = 0;
  for (const line of lines) {
    const match = line.match(/^(\d+)[.)\]]\s+(?:\[(High|Medium|Low)\]\s*)?(.+)$/);
    if (match) {
      index += 1;
      const severity = match[2] ?? null;
      const text = match[3]!.trim().slice(0, 200);
      if (text.length > 0) {
        findings.push({ text, severity, index });
      }
    }
  }

  if (findings.length === 0) return null;
  return { ts, findings };
}

interface ToClassifyEntry {
  findingId: string;
  finding: Finding;
  synthesisPath: string;
  ts: string;
}

export async function buildMemoryEfficacyCache(
  db: Database,
  opts: {
    reviewsDir: string;
    siriusChat: SiriusChatFn;
    model: string;
    sinceISO?: string;
  },
): Promise<{ scanned: number; classified: number; skipped: number }> {
  let scanned = 0;
  let classified = 0;
  let skipped = 0;

  const now = new Date().toISOString();

  let entries: string[];
  try {
    entries = readdirSync(opts.reviewsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { scanned: 0, classified: 0, skipped: 0 };
  }

  const sinceCutoff = new Date(opts.sinceISO ?? '1970-01-01T00:00:00Z').toISOString();

  const getIdStmt = db.prepare(
    `SELECT 1 FROM memory_efficacy_cache WHERE finding_id = ? LIMIT 1`,
  );
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO memory_efficacy_cache (
      finding_id, synthesis_path, ts, finding_index, finding_text,
      severity, classification, classifier_model, classified_at, raw_response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const toClassify: ToClassifyEntry[] = [];

  for (const entry of entries) {
    const dirTs = entry.replace(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/,
      '$1-$2-$3T$4:$5:$6Z',
    );
    if (dirTs < sinceCutoff) continue;

    const synthesisPath = join(opts.reviewsDir, entry, 'synthesis.md');
    const parsed = parseFindings(synthesisPath);
    if (!parsed) continue;

    scanned += parsed.findings.length;

    for (const finding of parsed.findings) {
      const findingId = hashFinding(synthesisPath, finding.index, finding.text);
      const cached = getIdStmt.get(findingId);
      if (cached) {
        skipped += 1;
        continue;
      }
      toClassify.push({
        findingId,
        finding,
        synthesisPath,
        ts: parsed.ts,
      });
    }
  }

  const batchSize = 10;
  for (let i = 0; i < toClassify.length; i += batchSize) {
    const batch = toClassify.slice(i, i + batchSize);
    const batchFindings = batch.map((e) => e.finding);

    const classifications = await classifyFindings(batchFindings, {
      siriusChat: opts.siriusChat,
      model: opts.model,
    });

    const clsByIndex = new Map<number, (typeof classifications)[number]>();
    for (const cls of classifications) {
      clsByIndex.set(cls.index, cls);
    }

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j]!;
      const cls = clsByIndex.get(entry.finding.index);
      if (!cls) continue;
      const normalizedTs = new Date(entry.ts).toISOString();

      insertStmt.run(
        entry.findingId,
        entry.synthesisPath,
        normalizedTs,
        entry.finding.index,
        entry.finding.text.slice(0, 200),
        entry.finding.severity,
        cls.classification,
        opts.model,
        now,
        cls.raw_response_json,
      );
      classified += 1;
    }
  }

  return { scanned, classified, skipped };
}
