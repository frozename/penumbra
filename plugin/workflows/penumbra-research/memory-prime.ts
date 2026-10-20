import type { WorkflowCtx } from "@penumbra/workflows";
import type { Database } from "bun:sqlite";

export type MemoryPrime = { brief: string; hits: number };

const TOP_K = 6;
const TITLE_MAX = 120;
const BODY_MAX = 400;
const BRIEF_BUDGET = 2000;

// Punctuation-safe FTS sanitizer: strip to alnum+space, collapse whitespace.
// A bare multi-word FTS5 MATCH is implicit-AND (every term required), which
// misses relevant prior findings, so OR-join the surviving terms.
export function sanitizeFtsQuery(question: string): string {
  const cleaned = question
    .replaceAll(/[^A-Za-z0-9\s]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "";
  return cleaned.split(/\s+/).filter(Boolean).join(" OR ");
}

export function primeFromMemory(
  ctx: WorkflowCtx,
  question: string,
  projectId: string,
): MemoryPrime {
  if (!ctx.db) return { brief: "", hits: 0 };
  const ftsQuery = sanitizeFtsQuery(question);
  if (ftsQuery.length === 0) return { brief: "", hits: 0 };
  let db: Database;
  try {
    db = ctx.db();
  } catch {
    return { brief: "", hits: 0 };
  }
  let rows: { title: string; body: string }[];
  try {
    rows = db
      .query<{ title: string; body: string }, [string, string, number]>(
        `SELECT t.title, t.body
         FROM t2_fts f
         JOIN t2_memories t ON t.rowid = f.rowid
         WHERE t2_fts MATCH ?
           AND (t.project_id IS NULL OR t.project_id = ?)
           AND COALESCE(json_extract(t.metadata_json, '$.trust'), '') != 'untrusted'
         ORDER BY bm25(t2_fts)
         LIMIT ?`,
      )
      .all(ftsQuery, projectId, TOP_K);
  } catch {
    return { brief: "", hits: 0 };
  }
  if (rows.length === 0) return { brief: "", hits: 0 };
  return { brief: buildBrief(rows), hits: rows.length };
}

function buildBrief(rows: { title: string; body: string }[]): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const title = row.title.slice(0, TITLE_MAX);
    const body = row.body.slice(0, BODY_MAX);
    const line = `- ${title}: ${body}`;
    if (bytes + line.length > BRIEF_BUDGET) break;
    lines.push(line);
    bytes += line.length + 1;
  }
  return lines.join("\n");
}
