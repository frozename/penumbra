import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Embedder } from "../embedder/interface.js";
import { isNearDuplicate, type NearDuplicateItem } from "../memory/near-dup.js";
import { T2MemoryWriteSchema, type T2MemoryWriteInput } from "../schemas/memory.js";
import type { Clock } from "../utils/clock.js";
import type { Uuid } from "../utils/uuid.js";

export const T2MemoryExtractionSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  kind: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  obs_type: z.string().nullable().optional(),
  why: z.string().nullable().optional(),
  source_quote: z.string().nullable().optional(),
  learned_at: z.string().nullable().optional(),
  durability: z.string().nullable().optional(),
  depth: z.number().int().nullable().optional(),
  is_episodic: z.boolean().nullable().optional(),
  promote: z.boolean().nullable().optional(),
});

export type T2MemoryExtraction = z.infer<typeof T2MemoryExtractionSchema>;

export type LLMJudge = (transcript: string) => Promise<T2MemoryExtraction[]>;

export type T2MemoryWriterInput = T2MemoryWriteInput;
export type { T2MemoryWriteInput };

export interface MemoryVerificationBasis {
  type: string;
  detail: string;
  basis: string;
}

export interface DirectT2WriteInput {
  slug?: string | null;
  hook?: string | null;
  sub_kind?: string | null;
  cc_kind?: string | null;
  why?: string | null;
  source_quote?: string | null;
  obs_type?: string | null;
  title: string;
  body: string;
  project_id?: string | null;
  source_session_ids?: string[];
  embedding: Float32Array;
}

export interface DirectT2WriteResult {
  memory_id: string;
  created: boolean;
}

export function writeDirectT2Memory(db: Database, input: DirectT2WriteInput): DirectT2WriteResult {
  const now = new Date().toISOString();
  const projectId = input.project_id ?? null;
  const slug = input.slug ?? null;
  const hook = input.hook ?? null;
  const subKind = input.sub_kind ?? null;
  const ccKind = input.cc_kind ?? null;
  const why = input.why ?? null;
  const sourceQuote = input.source_quote ?? null;
  const obsType = input.obs_type ?? null;
  const sourceSessionIds = [...new Set((input.source_session_ids ?? []).map((id) => id.trim()))].filter(
    (id) => id.length > 0,
  );
  const sourceSessionIdsJson = JSON.stringify(sourceSessionIds);

  if (slug !== null) {
    const existing = db
      .query<
        { memory_id: string },
        [string, string | null]
      >("SELECT memory_id FROM t2_memories WHERE slug = ? AND COALESCE(project_id, '') = COALESCE(?, '')")
      .get(slug, projectId);
    if (existing) {
      db.run(
        `UPDATE t2_memories
         SET kind = 'direct', origin = 'direct', title = ?, body = ?, hook = ?, sub_kind = ?, cc_kind = ?, why = ?, source_quote = ?, obs_type = ?, project_id = ?,
             source_session_ids = CASE WHEN ? = '[]' THEN source_session_ids ELSE ? END,
             learned_at = ?, updated_at = ?, retired_at = NULL
         WHERE memory_id = ?`,
        [
          input.title,
          input.body,
          hook,
          subKind,
          ccKind,
          why,
          sourceQuote,
          obsType,
          projectId,
          sourceSessionIdsJson,
          sourceSessionIdsJson,
          now,
          now,
          existing.memory_id,
        ],
      );
      const rowid = db
        .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id = ?")
        .get(existing.memory_id)!.rowid;
      db.run("DELETE FROM t2_vec WHERE rowid = ?", [rowid]);
      db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, input.embedding]);
      return { memory_id: existing.memory_id, created: false };
    }
  }

  const memoryId = randomUUID();
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json, compressed_from,
      created_at, updated_at, slug, hook, sub_kind, cc_kind, why, source_quote, obs_type, learned_at, origin
    )
    VALUES (?, ?, 'system', 'direct', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'direct')`,
    [
      memoryId,
      projectId,
      sourceSessionIdsJson,
      now,
      now,
      input.title,
      input.body,
      "{}",
      null,
      now,
      now,
      slug,
      hook,
      subKind,
      ccKind,
      why,
      sourceQuote,
      obsType,
      now,
    ],
  );

  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id = ?")
    .get(memoryId)!.rowid;
  // Defensive DELETE: SQLite reuses recently-freed rowids on INSERT, so an
  // orphan t2_vec row (left behind by a t2_memories DELETE that didn't cascade)
  // collides with the fresh INSERT here. vec0 virtual tables don't accept
  // INSERT OR REPLACE, so explicit DELETE+INSERT is the canonical pattern.
  db.run("DELETE FROM t2_vec WHERE rowid = ?", [rowid]);
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, input.embedding]);
  return { memory_id: memoryId, created: true };
}

export function verifyMemory(
  db: Database,
  memoryId: string,
  opts: {
    verifierActor: string;
    claimedBy?: string;
    reason?: string;
    sessionId?: string;
    basis?: MemoryVerificationBasis | null;
    authorizedByHandoff?: string | null;
    uuid: Uuid;
    now?: Clock;
  },
): {
  memory_id: string;
  last_verified_at: string;
  last_verified_by: string | null;
  last_verified_actor: string | null;
  last_verified_reason: string | null;
  last_verified_session_id: string | null;
  verifier_actor: string;
  claimed_by: string | null;
  event_id: string;
  basis: MemoryVerificationBasis | null;
  written: boolean;
} | null {
  const row = db
    .query<{ memory_id: string }, [string]>("SELECT memory_id FROM t2_memories WHERE memory_id = ?")
    .get(memoryId);
  if (!row) return null;

  const now = (opts.now ?? (() => new Date()))().toISOString();
  const verifierActor = opts.verifierActor;
  const claimedBy = opts.claimedBy ?? null;
  const reason = opts.reason ?? null;
  const sessionId = opts.sessionId ?? null;
  const basis = opts.basis ?? null;
  const authorizedByHandoff = opts.authorizedByHandoff ?? null;

  const eventId = opts.uuid();
  try {
    db.transaction(() => {
      db.run(
        "UPDATE t2_memories SET last_verified_at = ?, last_verified_by = ?, last_verified_actor = ?, last_verified_reason = ?, last_verified_session_id = ? WHERE memory_id = ?",
        [now, claimedBy, verifierActor, reason, sessionId, memoryId],
      );
      db.run(
        `INSERT INTO t2_memory_verification_events(
          event_id, memory_id, verifier_actor, claimed_by, reason, session_id, verified_at,
          basis, basis_type, basis_detail, authorized_by_handoff
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          memoryId,
          verifierActor,
          claimedBy,
          reason,
          sessionId,
          now,
          basis?.basis ?? null,
          basis?.type ?? null,
          basis?.detail ?? null,
          authorizedByHandoff,
        ],
      );
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes(
        "UNIQUE constraint failed: t2_memory_verification_events.memory_id, t2_memory_verification_events.session_id",
      )
    ) {
      return {
        memory_id: memoryId,
        last_verified_at: now,
        last_verified_by: claimedBy,
        last_verified_actor: verifierActor,
        last_verified_reason: reason,
        last_verified_session_id: sessionId,
        verifier_actor: verifierActor,
        claimed_by: claimedBy,
        event_id: eventId,
        basis,
        written: false,
      };
    }
    throw err;
  }
  return {
    memory_id: memoryId,
    last_verified_at: now,
    last_verified_by: claimedBy,
    last_verified_actor: verifierActor,
    last_verified_reason: reason,
    last_verified_session_id: sessionId,
    verifier_actor: verifierActor,
    claimed_by: claimedBy,
    event_id: eventId,
    basis,
    written: true,
  };
}

export async function writeT2Memory(db: Database, input: T2MemoryWriterInput): Promise<void> {
  const rec = T2MemoryWriteSchema.parse(input);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.run(
      `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                               window_start, window_end, title, body, metadata_json,
                               compressed_from, created_at, updated_at,
                               last_verified_at, last_verified_by, last_verified_reason, last_verified_session_id,
                               obs_type, concepts, severity, file_paths)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      [
        rec.memory_id,
        rec.project_id ?? null,
        rec.user_id,
        rec.kind,
        JSON.stringify(rec.source_session_ids ?? []),
        rec.window_start,
        rec.window_end,
        rec.title,
        rec.body,
        JSON.stringify(rec.metadata ?? {}),
        rec.compressed_from ?? null,
        now,
        now,
        rec.obs_type ?? null,
        JSON.stringify(rec.concepts ?? []),
        rec.severity ?? null,
        JSON.stringify(rec.file_paths ?? []),
      ],
    );

    const rowid = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id=?")
      .get(rec.memory_id)!.rowid;
    db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, rec.embedding]);
  })();
}

export interface T2PromotionOpts {
  db: Database;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  llm: LLMJudge;
  retryLimit?: number;
  minEvents?: number;
  minTranscriptChars?: number;
  maxTranscriptChars?: number;
  highFrequencyThreshold?: number;
}

export class T2Promotion {
  private readonly recentShapes = new Map<string, number>();
  private readonly promotedTranscriptHashes = new Set<string>();

  constructor(private readonly opts: T2PromotionOpts) {}

  /**
   * Promotes a T1 rollup to T2 memories using an LLM judge.
   * Returns the number of memories created.
   */
  async promoteRollup(rollupId: string): Promise<number> {
    const rollup = this.opts.db
      .query<
        {
          rollup_id: string;
          session_id: string;
          project_id: string | null;
          user_id: string;
          started_at: string;
          ended_at: string | null;
          origin: string | null;
        },
        [string]
      >(
        "SELECT rollup_id, session_id, project_id, user_id, started_at, ended_at, origin FROM t1_rollups WHERE rollup_id = ?",
      )
      .get(rollupId);

    if (!rollup) return 0;

    // Fetch transcript from t0_events
    const events = this.opts.db
      .query<
        { event_type: string; payload_summary: string | null; payload_json: string | null },
        [string]
      >(
        "SELECT event_type, payload_summary, payload_json FROM t0_events WHERE session_id = ? ORDER BY ts ASC",
      )
      .all(rollup.session_id);

    if (events.length === 0) {
      this.markPromoted(rollupId);
      return 0;
    }

    const transcript = events
      .filter((e) => e.event_type === "agent-prompt" || e.event_type === "agent-response")
      .map((e) => {
        const role = e.event_type === "agent-prompt" ? "User" : "Assistant";
        const content = pickTranscriptContent(e.payload_summary, e.payload_json);
        return content ? `${role}: ${content}` : null;
      })
      .filter(Boolean)
      .join("\n\n");

    if (!transcript) {
      this.markPromoted(rollupId);
      return 0;
    }

    try {
      const minTranscriptChars = this.opts.minTranscriptChars ?? 200;
      const maxTranscriptChars = this.opts.maxTranscriptChars ?? 20_000;
      const highFrequencyThreshold = this.opts.highFrequencyThreshold ?? 5;
      const rollupKind = rollup.origin ?? "t1_rollup";
      const shapeKey = `${rollup.project_id ?? ""}:${rollupKind}`;
      const transcriptLength = transcript.length;

      if (transcriptLength < minTranscriptChars) {
        this.markPromoted(rollupId);
        return 0;
      }

      let llmTranscript = transcript;
      if (transcriptLength > maxTranscriptChars) {
        llmTranscript = `${transcript.slice(0, 8000)}\n… [truncated] …\n${transcript.slice(-8000)}`;
      }

      const seenCount = (this.recentShapes.get(shapeKey) ?? 0) + 1;
      if (this.recentShapes.size >= 64 && !this.recentShapes.has(shapeKey)) {
        const firstKey = this.recentShapes.keys().next().value as string | undefined;
        if (firstKey !== undefined) this.recentShapes.delete(firstKey);
      }
      this.recentShapes.set(shapeKey, seenCount);
      if (seenCount > highFrequencyThreshold) {
        const transcriptHash = hashContent(transcript);
        if (this.promotedTranscriptHashes.has(transcriptHash)) {
          this.markPromoted(rollupId);
          return 0;
        }
        if (this.promotedTranscriptHashes.size >= 256) {
          const firstHash = this.promotedTranscriptHashes.values().next().value as string | undefined;
          if (firstHash !== undefined) this.promotedTranscriptHashes.delete(firstHash);
        }
        this.promotedTranscriptHashes.add(transcriptHash);
      }

      const rawExtractions = await this.opts.llm(llmTranscript);

      // LLM response schema validation
      const extractions: T2MemoryExtraction[] = [];
      for (const ext of rawExtractions) {
        const result = T2MemoryExtractionSchema.safeParse(ext);
        if (result.success) {
          extractions.push(result.data);
        } else {
          // If any extraction is malformed, we fail the whole rollup to avoid partial/garbage data.
          throw new Error(`LLM extraction failed validation: ${result.error.message}`);
        }
      }

      if (extractions.length === 0) {
        this.markPromoted(rollupId);
        return 0;
      }

      const promotionGateEnabled = isEnvGateEnabled("PENUMBRA_PROMOTION_GATE");
      const nearDupGateEnabled = isEnvGateEnabled("PENUMBRA_PROMOTION_NEAR_DUP_GATE");
      const nearDupThreshold = Number(process.env.PENUMBRA_PROMOTION_NEAR_DUP_THRESHOLD ?? "0.95");

      const filteredExtractions = promotionGateEnabled
        ? extractions.filter((extraction) => isPromotionCandidate(extraction))
        : extractions;

      if (filteredExtractions.length === 0) {
        this.markPromotionSkipped(rollupId);
        return 0;
      }

      const bodies = filteredExtractions.map((e) => e.body);
      const embeddings = await this.opts.embedder.embed(bodies);
      const existingNearDupCandidates = nearDupGateEnabled
        ? embeddings.map((embedding) =>
            readExistingNearDuplicateCandidates(
              this.opts.db,
              rollup.project_id,
              embedding,
              NEAR_DUP_QUERY_LIMIT,
            ),
          )
        : [];

      const insertedCount = this.opts.db.transaction(() => {
        const threshold = Number.isFinite(nearDupThreshold) ? nearDupThreshold : 0.95;
        const selectedCandidates: PendingNearDuplicateCandidate[] = [];
        let blockedByNearDupInTxn = false;

        for (let i = 0; i < filteredExtractions.length; i++) {
          const ext = filteredExtractions[i]!;
          const vec = embeddings[i]!;
          const candidate: PendingNearDuplicateCandidate = {
            extraction: ext,
            body: ext.body,
            why: ext.why ?? null,
            depth: ext.depth ?? null,
            embedding: vec,
            retireExistingIds: new Map<string, number>(),
          };

          if (nearDupGateEnabled) {
            const existingCandidates = existingNearDupCandidates[i] ?? [];
            const existingDup = isNearDuplicate(candidate, existingCandidates, threshold);
            if (existingDup) {
              blockedByNearDupInTxn = true;
              if (existingDup.winner === "existing") {
                continue;
              }
              candidate.retireExistingIds.set(existingDup.existing.memory_id, existingDup.similarity);
            }

            const batchDup = isNearDuplicate(candidate, selectedCandidates, threshold);
            if (batchDup) {
              blockedByNearDupInTxn = true;
              if (batchDup.winner === "existing") {
                continue;
              }
              const weakerIndex = selectedCandidates.indexOf(batchDup.existing);
              if (weakerIndex >= 0) {
                const weaker = selectedCandidates[weakerIndex]!;
                for (const [memoryId, similarity] of weaker.retireExistingIds) {
                  const prior = candidate.retireExistingIds.get(memoryId);
                  if (prior === undefined || similarity > prior) {
                    candidate.retireExistingIds.set(memoryId, similarity);
                  }
                }
                selectedCandidates.splice(weakerIndex, 1);
              }
            }
          }

          selectedCandidates.push(candidate);
        }

        let insertedCountInTxn = 0;
        const queuedRetireIds = new Set<string>();
        const now = this.opts.clock().toISOString();
        let nearDupCycleId: string | null = null;

        for (const pending of selectedCandidates) {
          const memoryId = this.opts.uuid();
          const ext = pending.extraction;
          this.opts.db.run(
            `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                                     window_start, window_end, title, body, metadata_json,
                                     obs_type, why, source_quote, learned_at, durability, depth, is_episodic,
                                     created_at, updated_at, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              memoryId,
              rollup.project_id,
              rollup.user_id,
              ext.kind,
              JSON.stringify([rollup.session_id]),
              rollup.started_at,
              rollup.ended_at || rollup.started_at,
              ext.title,
              ext.body,
              JSON.stringify(ext.metadata || {}),
              ext.obs_type ?? null,
              ext.why ?? null,
              ext.source_quote ?? null,
              ext.learned_at ?? null,
              ext.durability ?? null,
              ext.depth ?? null,
              ext.is_episodic ? 1 : 0,
              now,
              now,
              rollup.origin,
            ],
          );

          const rowid = this.opts.db
            .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id=?")
            .get(memoryId)!.rowid;
          this.opts.db.run("DELETE FROM t2_vec WHERE rowid = ?", [rowid]);
          this.opts.db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, pending.embedding]);
          insertedCountInTxn += 1;

          if (!nearDupGateEnabled) continue;
          for (const [existingMemoryId, similarity] of pending.retireExistingIds) {
            if (queuedRetireIds.has(existingMemoryId)) continue;
            if (!nearDupCycleId) nearDupCycleId = ensureNearDupRetireCycle(this.opts.db, now);
            const enqueued = enqueueNearDupRetireAction(this.opts.db, {
              cycleId: nearDupCycleId,
              actionId: this.opts.uuid(),
              memoryId: existingMemoryId,
              similarity,
            });
            if (enqueued) queuedRetireIds.add(existingMemoryId);
          }
        }

        if (insertedCountInTxn > 0) this.markPromoted(rollupId);
        if (insertedCountInTxn === 0 && (blockedByNearDupInTxn || promotionGateEnabled)) {
          this.markPromotionSkipped(rollupId);
        }
        return insertedCountInTxn;
      })();

      return insertedCount;
    } catch (err) {
      this.recordFailure(rollupId);
      throw err;
    }
  }

  private markPromoted(rollupId: string): void {
    this.opts.db.run(
      "UPDATE t1_rollups SET t2_promoted_at = ?, promotion_skipped_at = NULL, failed_promotion_attempts = 0 WHERE rollup_id = ?",
      [this.opts.clock().toISOString(), rollupId],
    );
  }

  private markPromotionSkipped(rollupId: string): void {
    this.opts.db.run("UPDATE t1_rollups SET promotion_skipped_at = ? WHERE rollup_id = ?", [
      this.opts.clock().toISOString(),
      rollupId,
    ]);
  }

  private recordFailure(rollupId: string): void {
    this.opts.db.run(
      "UPDATE t1_rollups SET failed_promotion_attempts = failed_promotion_attempts + 1 WHERE rollup_id = ?",
      [rollupId],
    );
  }

  /**
   * Detects rollups that have not been promoted to T2 and are older than delayHours.
   * Skips rollups that have reached the retry limit.
   */
  detectEligibleRollups(delayHours: number, now: Date, minEvents?: number): string[] {
    const cutoff = new Date(now.getTime() - delayHours * 3600_000).toISOString();
    const limit = this.opts.retryLimit ?? 5;
    const finalMinEvents = minEvents ?? this.opts.minEvents ?? 5;
    return this.opts.db
      .query<{ rollup_id: string }, [string, string, number, number]>(
        `SELECT rollup_id FROM t1_rollups 
         WHERE t2_promoted_at IS NULL 
           AND promotion_skipped_at IS NULL
           AND (ended_at < ? OR (ended_at IS NULL AND started_at < ?))
           AND failed_promotion_attempts < ?
           AND n_events >= ?`,
      )
      .all(cutoff, cutoff, limit, finalMinEvents)
      .map((r) => r.rollup_id);
  }
}

interface ExistingNearDuplicateCandidate extends NearDuplicateItem {
  memory_id: string;
}

interface PendingNearDuplicateCandidate extends NearDuplicateItem {
  extraction: T2MemoryExtraction;
  retireExistingIds: Map<string, number>;
}

const NEAR_DUP_QUERY_LIMIT = 10;
const NEAR_DUP_RETIRE_CYCLE_ID = "t2-promotion-near-dup";

function isPromotionCandidate(extraction: T2MemoryExtraction): boolean {
  if (extraction.promote === false) return false;
  if (extraction.is_episodic === true) return false;
  if (extraction.obs_type === "standing_brief") return false;
  const depth = extraction.depth ?? 0;
  if (extraction.body.trim().length < 80 && depth < 2) return false;
  return true;
}

function readExistingNearDuplicateCandidates(
  db: Database,
  projectId: string | null,
  embedding: Float32Array,
  limit: number,
): ExistingNearDuplicateCandidate[] {
  const rows = db
    .query<
      {
        memory_id: string;
        body: string;
        why: string | null;
        depth: number | null;
        embedding: unknown;
      },
      [string | null, Float32Array, number]
    >(
      `SELECT m.memory_id, m.body, m.why, m.depth, v.embedding
       FROM t2_memories m
       JOIN t2_vec v ON v.rowid = m.rowid
       WHERE m.retired_at IS NULL
         AND m.project_id IS ?
       ORDER BY vec_distance_cosine(v.embedding, ?)
       LIMIT ?`,
    )
    .all(projectId, embedding, limit);

  const candidates: ExistingNearDuplicateCandidate[] = [];
  for (const row of rows) {
    const embedding = toFloat32Array(row.embedding, row.memory_id);
    if (!embedding) continue;
    candidates.push({
      memory_id: row.memory_id,
      body: row.body,
      why: row.why,
      depth: row.depth,
      embedding,
    });
  }
  return candidates;
}

function toFloat32Array(value: unknown, memoryId?: string): Float32Array | null {
  try {
    if (value instanceof Float32Array) return value;
    if (value instanceof ArrayBuffer) return new Float32Array(value);
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[t2-promotion] failed to decode embedding for memory_id=${memoryId ?? "unknown"}: ${errMsg}`);
    return null;
  }
  return null;
}

function isEnvGateEnabled(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function pickTranscriptContent(payloadSummary: string | null, payloadJson: string | null): string {
  const summary = (payloadSummary ?? "").trim();
  if (summary) return summary;
  if (!payloadJson) return "";
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return extractPayloadText(parsed).trim();
  } catch {
    return "";
  }
}

function extractPayloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return (
    readString(record.text) ??
    readString(record.message) ??
    readString(record.prompt) ??
    readString(record.message_excerpt) ??
    readString(record.response) ??
    extractResponseText(record.response) ??
    extractInputText(record.input) ??
    ""
  );
}

function extractResponseText(response: unknown): string | null {
  if (typeof response === "string") return response;
  if (Array.isArray(response) && response.length > 0) {
    const first = response[0];
    if (first && typeof first === "object") return readString((first as Record<string, unknown>).text);
  }
  if (response && typeof response === "object") {
    return readString((response as Record<string, unknown>).text);
  }
  return null;
}

function extractInputText(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return readString(record.text) ?? readString(record.message) ?? readString(record.prompt);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ensureNearDupRetireCycle(db: Database, nowIso: string): string {
  const existing = db
    .query<{ cycle_id: string }, [string]>("SELECT cycle_id FROM dream_cycles WHERE cycle_id = ?")
    .get(NEAR_DUP_RETIRE_CYCLE_ID);
  if (existing?.cycle_id) return NEAR_DUP_RETIRE_CYCLE_ID;

  db.run(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 't2-promotion-near-dup', 0, 'completed', '[]')`,
    [NEAR_DUP_RETIRE_CYCLE_ID, nowIso],
  );
  return NEAR_DUP_RETIRE_CYCLE_ID;
}

function enqueueNearDupRetireAction(
  db: Database,
  opts: {
    cycleId: string;
    actionId: string;
    memoryId: string;
    similarity: number;
  },
): boolean {
  const targetIds = JSON.stringify([opts.memoryId]);
  const alreadyQueued = db
    .query<{ action_id: string }, [string]>(
      `SELECT action_id
         FROM dream_actions
        WHERE action_type = 'retire'
          AND status IN ('queued', 'approved', 'auto_applied')
          AND reverted_by IS NULL
          AND target_ids = ?
        LIMIT 1`,
    )
    .get(targetIds);
  if (alreadyQueued) return false;

  db.run(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, ?, 'P3', 'retire', ?, 'queued', ?, ?)`,
    [
      opts.actionId,
      opts.cycleId,
      Math.max(0, Math.min(1, opts.similarity)),
      targetIds,
      JSON.stringify({ source: "t2_promotion_near_dup_gate" }),
    ],
  );
  return true;
}
