import { Database } from "bun:sqlite";
import type { Embedder } from "../embedder/interface.js";
import { isNearDuplicate } from "../memory/near-dup.js";
import {
  readExistingNearDuplicateCandidates,
  T2MemoryExtractionSchema,
  type T2MemoryExtraction,
} from "./t2.js";
import { buildT2EmbedText, validateT2Body } from "./t2-embed-text.js";

const DEFAULT_MIN_TRANSCRIPT_CHARS = 200;
const DEFAULT_MAX_CANDIDATES = 15;
const DEFAULT_NEAR_DUP_THRESHOLD = 0.95;
const NEAR_DUP_QUERY_LIMIT = 10;

export interface SessionExtractCandidate {
  action: "create" | "update";
  slug: string;
  update_existing_slug?: string;
  existing_memory_id?: string;
  title: string;
  body: string;
  hook: string;
  kind: string;
  metadata?: Record<string, unknown>;
  obs_type?: string | null;
  why: string;
  source_quote?: string | null;
  learned_at?: string | null;
  durability?: string | null;
  depth?: number | null;
  is_episodic?: boolean | null;
  promote?: boolean | null;
  backlinks: string[];
  embedding: Float32Array;
}

export interface SessionExtractOpts {
  db: Database;
  embedder: Embedder;
  llm: (transcript: string) => Promise<T2MemoryExtraction[]>;
  project_id?: string | null;
  maxCandidates?: number;
  minTranscriptChars?: number;
  nearDuplicateThreshold?: number;
}

export async function extractSessionCandidates(
  opts: SessionExtractOpts,
  transcript: string,
): Promise<SessionExtractCandidate[]> {
  const cleanedTranscript = transcript.trim();
  if (cleanedTranscript.length < (opts.minTranscriptChars ?? DEFAULT_MIN_TRANSCRIPT_CHARS)) {
    return [];
  }

  const rawExtractions = await opts.llm(cleanedTranscript);
  const extractions: T2MemoryExtraction[] = [];
  for (const raw of rawExtractions) {
    const parsed = T2MemoryExtractionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`LLM extraction failed validation: ${parsed.error.message}`);
    }
    if (validateExtractQuality(parsed.data)) {
      extractions.push(parsed.data);
    }
  }
  if (extractions.length === 0) return [];

  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const bounded = extractions.slice(0, maxCandidates);
  const embedTexts = bounded.map((candidate) => buildT2EmbedText(candidate.title, candidate.body));
  const embeddings = await opts.embedder.embed(embedTexts);
  const out: SessionExtractCandidate[] = [];

  for (let i = 0; i < bounded.length && out.length < maxCandidates; i++) {
    const extraction = bounded[i]!;
    const embedding = embeddings[i];
    if (!embedding) continue;

    const slug = slugify(extraction.title);
    const slugMatch = findExistingBySlug(opts.db, slug, opts.project_id ?? null);
    const nearDupMatch = isNearDuplicate(
      {
        body: extraction.body,
        why: extraction.why ?? null,
        depth: extraction.depth ?? null,
        embedding,
      },
      readExistingNearDuplicateCandidates(
        opts.db,
        opts.project_id ?? null,
        embedding,
        NEAR_DUP_QUERY_LIMIT,
      ),
      opts.nearDuplicateThreshold ?? DEFAULT_NEAR_DUP_THRESHOLD,
    );

    const existing =
      slugMatch ??
      (nearDupMatch?.winner === "existing"
        ? {
            memory_id: nearDupMatch.existing.memory_id,
            slug: nearDupMatch.existing.slug ?? null,
          }
        : null);
    const updateSlug = existing?.slug ?? slug;

    out.push({
      action: existing ? "update" : "create",
      slug,
      ...(existing
        ? {
            existing_memory_id: existing.memory_id,
            update_existing_slug: updateSlug,
          }
        : {}),
      title: extraction.title,
      body: extraction.body,
      hook: buildHook(extraction),
      kind: extraction.kind,
      ...(extraction.metadata ? { metadata: extraction.metadata } : {}),
      obs_type: extraction.obs_type ?? null,
      why: extraction.why!.trim(),
      source_quote: extraction.source_quote ?? null,
      learned_at: extraction.learned_at ?? null,
      durability: extraction.durability ?? null,
      depth: extraction.depth ?? null,
      is_episodic: extraction.is_episodic ?? null,
      promote: extraction.promote ?? null,
      backlinks: resolveBacklinks(
        opts.db,
        extraction.title,
        opts.project_id ?? null,
        existing?.memory_id,
      ),
      embedding,
    });
  }

  return out;
}

function buildHook(extraction: T2MemoryExtraction): string {
  const source = extraction.why?.trim() || extraction.title.trim();
  return source.replace(/\s+/g, " ").slice(0, 180);
}

function validateExtractQuality(extraction: T2MemoryExtraction): boolean {
  if (extraction.promote === false) return false;
  if (extraction.is_episodic === true) return false;
  if (extraction.obs_type === "standing_brief") return false;

  const validation = validateT2Body(extraction.body);
  if (!validation.ok) return false;

  const why = extraction.why?.trim();
  if (!why || why.length < 20) return false;

  const depth = extraction.depth ?? 0;
  if (extraction.body.trim().length < 80 && depth < 2) return false;

  if (isBareRediscoverableFact(extraction)) return false;
  return true;
}

function isBareRediscoverableFact(extraction: T2MemoryExtraction): boolean {
  if (extraction.kind !== "fact") return false;
  const body = extraction.body.trim().toLowerCase();
  const hasDurableHook =
    /\b(because|so that|therefore|instead|avoid|prefer|requires?|must|should|when|whenever|workaround|future|preserv(?:e|es)|route|use)\b/.test(
      body,
    );
  if (hasDurableHook) return false;
  return /\b(file|directory|package|function|class|repo|repository|exists|contains|lives at)\b/.test(
    body,
  );
}

function findExistingBySlug(
  db: Database,
  slug: string,
  projectId: string | null,
): { memory_id: string; slug: string | null } | null {
  return (
    db
      .query<
        { memory_id: string; slug: string | null },
        [string, string | null]
      >("SELECT memory_id, slug FROM t2_memories WHERE slug = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND retired_at IS NULL")
      .get(slug, projectId) ?? null
  );
}

function resolveBacklinks(
  db: Database,
  title: string,
  projectId: string | null,
  excludeMemoryId?: string | null,
): string[] {
  const tokens = titleTokens(title);
  if (tokens.length < 2) return [];
  const query = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
  try {
    const rows = db
      .query<{ memory_id: string }, [string, string | null, string | null, string | null]>(
        `SELECT m.memory_id
           FROM t2_fts
           JOIN t2_memories m ON m.rowid = t2_fts.rowid
          WHERE t2_fts MATCH ?
            AND m.retired_at IS NULL
            AND m.project_id IS ?
            AND (? IS NULL OR m.memory_id != ?)
          ORDER BY bm25(t2_fts)
          LIMIT 3`,
      )
      .all(query, projectId, excludeMemoryId ?? null, excludeMemoryId ?? null);
    return rows.map((row) => row.memory_id);
  } catch {
    return [];
  }
}

function titleTokens(title: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "into", "that", "this"]);
  return [
    ...new Set(
      title
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g)
        ?.filter((token) => !stop.has(token)) ?? [],
    ),
  ].slice(0, 5);
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
  return slug || "session-extract";
}
