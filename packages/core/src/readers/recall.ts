import { getConfig } from "@penumbra/config";
import { Database } from "bun:sqlite";

import type { Embedder } from "../embedder/interface.js";
import type { RecallRequest, RecallResult } from "../schemas/recall.js";

import { hybridSearch } from "./hybrid.js";
import { fuseRRF, type RankedResult } from "./rrf.js";
import { toScore } from "./vec-score.js";

type RecallPayload = RecallResult & { verification_count?: number };

const VERIFIED_BOOST_MULTIPLIER = 1.05;
const VERIFIED_RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class RecallReader {
  private readonly db: Database;
  private readonly embedder: Embedder;

  constructor(opts: { db: Database; embedder: Embedder }) {
    this.db = opts.db;
    this.embedder = opts.embedder;
  }

  /**
   * Returns up to `req.limit` results across T0 events, T1 rollups and T2 memories.
   *
   * Each tier is queried with limit, filtered by min_score, and then fused
   * using Reciprocal Rank Fusion (RRF).
   */
  async recall(req: RecallRequest): Promise<RecallResult[]> {
    if (req.strategy_hint === "hybrid") {
      return await runHybridRecall(this.db, this.embedder, req);
    }
    const perTierLimit = req.limit * resolveOversampleFactor();
    const requestedSources = req.sources ?? (req.include_raw ? ["t0", "t1", "t2"] : ["t1", "t2"]);

    const needsVector = requestedSources.includes("t1") || requestedSources.includes("t2");
    const qvec = needsVector ? (await this.embedder.embed([req.query]))[0] : undefined;

    const t0Results = requestedSources.includes("t0")
      ? collectT0Results(this.db, req, perTierLimit)
      : [];
    const t1Results =
      requestedSources.includes("t1") && qvec
        ? collectT1Results(this.db, req, perTierLimit, qvec)
        : [];
    const t2Results =
      requestedSources.includes("t2") && qvec
        ? collectT2Results(this.db, req, perTierLimit, qvec)
        : [];

    const sourceMap = ["t0", "t1", "t2"] as const;
    const fused = applyVerifiedBoost(
      fuseRRF([t0Results, t1Results, t2Results], { k: req.rrf_k }),
      isVerifiedBoostEnabled(process.env),
    );

    return fused.slice(0, req.limit).map((f) => {
      const { verification_count: _verificationCount, ...payload } = f.payload;
      return {
        ...payload,
        fusedScore: f.fusedScore,
        sources: f.sources.map((idx) => {
          const tier = sourceMap[idx];
          if (tier === undefined) throw new Error(`invalid source index ${String(idx)}`);
          return tier;
        }),
      };
    });
  }
}

async function runHybridRecall(
  db: Database,
  embedder: Embedder,
  req: RecallRequest,
): Promise<RecallResult[]> {
  const hits = await hybridSearch(db, embedder, {
    query: req.query,
    limit: req.limit,
    project_id: req.project_id,
    obs_type: req.obs_type,
    concept: req.concept,
    file_path: req.file_path,
    dateStart: req.dateStart,
    dateEnd: req.dateEnd,
  });
  return hits.map((h) => ({
    id: h.id,
    tier: "t2",
    score: h.score,
    fusedScore: 0,
    sources: ["t2"],
    title: h.title,
    body: h.body,
    project_id: h.project_id,
    source_session_ids: h.source_session_ids,
    created_at: h.ts,
    ts: h.ts,
    why: h.why,
    source_quote: h.source_quote,
    learned_at: h.learned_at,
    last_verified_at: h.last_verified_at,
  }));
}

function resolveOversampleFactor(): number {
  const raw = getConfig(process.env).env.PENUMBRA_T2_OVERSAMPLE_FACTOR;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

function collectT0Results(
  db: Database,
  req: RecallRequest,
  perTierLimit: number,
): RankedResult<RecallPayload>[] {
  const raw = queryT0(db, {
    query: req.query,
    limit: perTierLimit,
    project_id: req.project_id,
    session_id: req.session_id,
    event_types: req.event_types,
    file_path: req.file_path,
    include_untrusted: req.include_untrusted,
  });
  return raw
    .filter((r) => r.score >= req.min_score)
    .map((r) => ({
      id: r.event_id,
      score: r.score,
      payload: {
        id: r.event_id,
        tier: "t0",
        score: r.score,
        fusedScore: 0,
        sources: ["t0"],
        title: null,
        body: r.content_snippet,
        project_id: r.project_id,
        source_session_ids: r.session_id ? [r.session_id] : [],
        created_at: r.ts,
        ts: r.ts,
        payload: { event_type: r.event_type },
      },
    }));
}

function collectT1Results(
  db: Database,
  req: RecallRequest,
  perTierLimit: number,
  qvec: Float32Array,
): RankedResult<RecallPayload>[] {
  type T1Row = {
    rollup_id: string;
    project_id: string | null;
    session_id: string;
    started_at: string;
    first_prompt_excerpt: string | null;
    last_response_excerpt: string | null;
    distance: number;
  };
  const rows = db
    .query<
      T1Row,
      [Float32Array, number, string | null, string | null, string | null, string | null]
    >(
      `SELECT r.rollup_id, r.project_id, r.session_id, r.started_at,
              r.first_prompt_excerpt, r.last_response_excerpt,
              v.distance
         FROM t1_vec v
         JOIN t1_rollups r ON r.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
          AND (? IS NULL OR r.project_id = ?)
          AND (? IS NULL OR r.session_id = ?)
        ORDER BY v.distance ASC`,
    )
    .all(
      qvec,
      perTierLimit,
      req.project_id,
      req.project_id,
      req.session_id ?? null,
      req.session_id ?? null,
    );

  return rows
    .map((r): RankedResult<RecallPayload> => {
      const score = toScore(r.distance);
      return {
        id: r.rollup_id,
        score,
        payload: {
          id: r.rollup_id,
          tier: "t1" as const,
          score,
          fusedScore: 0,
          sources: ["t1"],
          title: null,
          body: [r.first_prompt_excerpt, r.last_response_excerpt]
            .filter((s): s is string => !!s)
            .join("\n\n"),
          project_id: r.project_id,
          source_session_ids: [r.session_id],
          created_at: r.started_at,
          ts: r.started_at,
          payload: { rollup_id: r.rollup_id },
        },
      };
    })
    .filter((r) => r.score >= req.min_score);
}

function collectT2Results(
  db: Database,
  req: RecallRequest,
  perTierLimit: number,
  qvec: Float32Array,
): RankedResult<RecallPayload>[] {
  type T2Row = {
    memory_id: string;
    project_id: string | null;
    title: string;
    body: string;
    created_at: string;
    source_session_ids: string;
    why: string | null;
    source_quote: string | null;
    learned_at: string | null;
    last_verified_at: string | null;
    verification_count: number;
    distance: number;
  };
  const rows = db
    .query<T2Row, [Float32Array, number, string | null, string | null]>(
      `SELECT m.memory_id, m.project_id, m.title, m.body, m.created_at, m.source_session_ids,
              m.why, m.source_quote, m.learned_at, m.last_verified_at,
              (SELECT COUNT(*) FROM t2_memory_verification_events ve
                WHERE ve.memory_id = m.memory_id) AS verification_count,
              v.distance
         FROM t2_vec v
         JOIN t2_memories m ON m.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
          AND (? IS NULL OR m.project_id = ?)
          AND m.retired_at IS NULL
        ORDER BY v.distance ASC`,
    )
    .all(qvec, perTierLimit, req.project_id, req.project_id);

  return rows
    .map((r): RankedResult<RecallPayload> => {
      const score = toScore(r.distance);
      return {
        id: r.memory_id,
        score,
        payload: {
          id: r.memory_id,
          tier: "t2" as const,
          score,
          fusedScore: 0,
          sources: ["t2" as const],
          title: r.title,
          body: r.body,
          project_id: r.project_id,
          source_session_ids: JSON.parse(r.source_session_ids) as string[],
          created_at: r.created_at,
          ts: r.created_at,
          why: r.why,
          source_quote: r.source_quote,
          learned_at: r.learned_at,
          last_verified_at: r.last_verified_at,
          verification_count: r.verification_count,
          payload: { memory_id: r.memory_id },
        },
      };
    })
    .filter((r) => r.score >= req.min_score);
}

function applyVerifiedBoost<T extends RecallPayload>(
  fused: (RankedResult<T> & { fusedScore: number; sources: number[] })[],
  enabled: boolean,
): (RankedResult<T> & { fusedScore: number; sources: number[] })[] {
  if (!enabled || fused.length < 2) return fused;
  const now = Date.now();
  return [...fused].sort((a, b) => {
    const aScore = boostedScore(a, now);
    const bScore = boostedScore(b, now);
    if (aScore !== bScore) return bScore - aScore;
    return 0;
  });
}

function boostedScore<T extends RecallPayload>(
  item: RankedResult<T> & { fusedScore: number },
  now: number,
): number {
  return isVerifiedBoostEligible(item.payload, now)
    ? item.fusedScore * VERIFIED_BOOST_MULTIPLIER
    : item.fusedScore;
}

function isVerifiedBoostEligible(payload: RecallPayload, now: number): boolean {
  if (payload.tier !== "t2") return false;
  if ((payload.verification_count ?? 0) > 0) return true;
  if (!payload.last_verified_at) return false;
  const verifiedAt = new Date(payload.last_verified_at).getTime();
  return Number.isFinite(verifiedAt) && now - verifiedAt <= VERIFIED_RECENCY_WINDOW_MS;
}

function isVerifiedBoostEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes"].includes((env.PENUMBRA_RECALL_VERIFIED_BOOST ?? "").toLowerCase());
}

export interface QueryT0Options {
  query: string;
  limit?: number; // default 50
  project_id?: string | null;
  session_id?: string;
  event_types?: string[];
  /** Restrict results to t0 events that touched this file path (joined via t0_file_refs). */
  file_path?: string;
  /** Include payloads explicitly marked as untrusted (default: false). */
  include_untrusted?: boolean;
}

export interface T0RecallResult {
  event_id: string;
  /**
   * Normalized lexical relevance score in [0, 1].
   *
   * SQLite FTS5 `bm25()` returns lower-is-better scores (often negative). This
   * maps results into a similarity-like score where higher is better by
   * normalizing each row relative to the best match in the result set:
   * `score = 1 / (1 + max(0, bm25 - bestBm25))`.
   */
  score: number;
  content_snippet: string;
  ts: string;
  event_type: string;
  project_id: string | null;
  session_id: string | null;
}

export function queryT0(db: Database, opts: QueryT0Options): T0RecallResult[] {
  const limit = opts.limit ?? 50;
  const q = opts.query.trim();
  if (!q) return [];

  const matchQuery = sanitizeFts5Query(q);
  if (!matchQuery) return [];

  type Row = {
    event_id: string;
    bm25: number;
    content: string;
    snippet: string | null;
    ts: string;
    event_type: string;
    project_id: string | null;
    session_id: string | null;
  };

  const where: string[] = ["t0_fts MATCH ?"];
  const params: (string | number | null)[] = [matchQuery];

  // Exclude memory_recall MCP calls captured by the PreToolUse hook. Their
  // payload_summary contains the verbatim query text, so they always score
  // as the top match for any query that uses the same terms — recall would
  // forever surface its own prior calls before any real content. The hook
  // captures these as event_type='agent-tool-use' with summary starting
  // 'mcp__penumbra__memory_recall('.
  where.push(
    "NOT (e.event_type = 'agent-tool-use' AND e.payload_summary LIKE 'mcp__penumbra__memory_recall%')",
  );
  if (!opts.include_untrusted) {
    where.push("COALESCE(json_extract(e.payload_json, '$.trust'), '') != 'untrusted'");
  }

  const projectId = opts.project_id ?? null;
  if (projectId !== null) {
    where.push("e.project_id = ?");
    params.push(projectId);
  }

  if (opts.session_id !== undefined) {
    where.push("e.session_id = ?");
    params.push(opts.session_id);
  }

  if (opts.event_types && opts.event_types.length > 0) {
    const placeholders = opts.event_types.map(() => "?").join(",");
    where.push(`e.event_type IN (${placeholders})`);
    params.push(...opts.event_types);
  }

  params.push(limit);

  const fileJoin = opts.file_path
    ? "INNER JOIN t0_file_refs r ON r.event_id = e.event_id AND r.file_path = ?"
    : "";
  if (opts.file_path) {
    // SQL parses ? in source order. The JOIN's `?` precedes every WHERE-clause `?`,
    // so the file_path binding must come FIRST in params, ahead of matchQuery.
    params.unshift(opts.file_path);
  }

  const rows = db
    .query<Row, (string | number | null)[]>(
      `SELECT t0_fts.event_id,
              bm25(t0_fts) AS bm25,
              t0_fts.content AS content,
              snippet(t0_fts, 0, '', '', '…', 16) AS snippet,
              e.ts,
              e.event_type,
              e.project_id,
              e.session_id
         FROM t0_fts
         JOIN t0_events e ON e.event_id = t0_fts.event_id
         ${fileJoin}
        WHERE ${where.join(" AND ")}
        ORDER BY bm25(t0_fts) ASC
        LIMIT ?`,
    )
    .all(...params);

  const bestBm25 = rows[0]?.bm25;

  return rows.map((r) => ({
    event_id: r.event_id,
    score: bm25ToScore(r.bm25, bestBm25),
    content_snippet: pickSnippet(r),
    ts: r.ts,
    event_type: r.event_type,
    project_id: r.project_id,
    session_id: r.session_id,
  }));
}

function bm25ToScore(bm25: number, bestBm25: number | undefined): number {
  if (!Number.isFinite(bm25) || bestBm25 === undefined || !Number.isFinite(bestBm25)) return 0;
  const delta = bm25 - bestBm25;
  return 1 / (1 + Math.max(0, delta));
}

function pickSnippet(row: { snippet: string | null; content: string }): string {
  const snippet = row.snippet?.trim();
  if (snippet) return snippet;
  return row.content.slice(0, 200);
}

function sanitizeFts5Query(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => /[0-9A-Za-z]/.test(t))
    .slice(0, 20);

  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${escapeFts5PhraseToken(t)}"`).join(" OR ");
}

function escapeFts5PhraseToken(token: string): string {
  // FTS5 phrase quoting escapes `"` by doubling: foo"bar -> "foo""bar"
  return token.replaceAll('"', '""');
}
