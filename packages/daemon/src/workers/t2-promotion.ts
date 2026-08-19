import type { AgentChatConfig } from "@penumbra/config";
import type { Embedder, Services, T2MemoryExtraction } from "@penumbra/core";

import { buildT2EmbedText, T2Promotion } from "@penumbra/core";

import { resolveRoleLlmCandidates } from "../../../core/src/services/llm-candidates.js";

import { loadAgentChatConfig, resolveAgentChatConfigPath } from "../agentchat-config.js";
import {
  createJudgePool,
  getJudgeTimeoutMs,
  type JudgeEntry,
  type JudgePool,
} from "./t2-judge-pool.js";

export const T2_PROMPT_FILTER_RULE =
  "If a memory could be retrieved later by `git log`, `grep`, `find`, or just reading the code, DO NOT extract it. Memory is for things that take judgment to discover, not things that are mechanically discoverable.";

export const T2_PROMOTION_PROMPT = `
You are extracting durable knowledge from a session transcript for long-term memory used by future sessions, possibly weeks or months from now. Your bar is high: extract ONLY things that future-you would benefit from knowing, not things any tool can rediscover.

EXTRACT (✅):
- Architectural decisions WITH rationale ("we chose Postgres over SQLite for the audit log because partitioning matters at 50 writes/sec")
- User preferences that persist across sessions ("user prefers vitest over jest to avoid config sprawl", "always run typecheck before tests")
- Project rules / conventions that are not trivially derivable from the code ("orchestrate dispatches must use trust=all", "agent branches are named agent/<handoff_id>")
- Long-lived domain facts that take time to discover ("the t2_vec table doesn't auto-reset when t2_memories is emptied — orphans remain")
- Traps, pitfalls, gotchas with their workaround ("granite emits <think> tags before JSON; strip them or parse fails")

DO NOT EXTRACT (❌):
- Single test runs ("ran bun test, 626 passed", "8 tests passed in 9ms")
- Single git commits ("committed as 54d00a1", "added retry logic in commit X") — git log already has this
- File paths / directory listings ("the worker is at packages/agentchat/...", "directories include adapters, cli, config") — find/grep already has this
- Transient session activity ("user opened the README", "tests are running", "build is green")
- Surface facts derivable from the code ("the project uses TypeScript", "tests live under test/")
- Anything that reads like a status update with no carry-over context

${T2_PROMPT_FILTER_RULE}

Discriminator rules (required for gateable promotion):
- Episodic narration (example: "a failing test was written, then implementation followed") must be tagged \`obs_type: "is_episodic"\` and \`promote: false\`.
- Long-lived standing instructions (example: "You are X, a long-lived agent...") must be tagged \`obs_type: "standing_brief"\` and \`promote: false\`.
- Density floor: when \`body\` is under 80 characters and \`depth < 2\`, set \`promote: false\`.
- Depth escape hatch: deep items (\`depth >= 2\`) may still be promotable even when short.
- Durable semantic facts with explicit rationale should include a non-empty \`why\` and set \`promote: true\`.

If nothing in the transcript clears the bar, the CORRECT answer is the literal string \`{"memories":[]}\` — an empty array. NOT the word "none", NOT "null", NOT prose explaining why nothing matched. Just \`{"memories":[]}\`. This is the right answer for chitchat, pure activity logs, and anything below the bar.

Output ONLY a valid JSON object: {"memories": [...]}. Each memory object: { title (short headline), body (the durable knowledge itself), kind ("fact" | "preference" | "decision" | "knowledge"), metadata (optional object), obs_type (optional string), why (optional string), source_quote (optional string), learned_at (optional ISO-8601 string), durability (optional string), depth (optional integer), is_episodic (optional boolean), promote (optional boolean) }. No prose. No code fence. No wrapper tags. No "none"/"null" string fallbacks.

Transcript:
{{TRANSCRIPT}}
`.trim();

export interface PromotionWorkerOpts {
  services: Services;
  delayHours: number;
  llm?: (transcript: string) => Promise<T2MemoryExtraction[]>;
  minEvents?: number;
}

type ChunkedJudgeLogFn = (...a: unknown[]) => void;

export interface ChunkedJudgeLogger {
  info?: ChunkedJudgeLogFn;
  warn?: ChunkedJudgeLogFn;
}

export interface ChunkedJudgeOpts {
  judge: (transcript: string) => Promise<T2MemoryExtraction[]>;
  /** Soft character budget per chunk. Defaults to 80_000 chars (~20k tokens). */
  maxCharsPerChunk?: number;
  log?: ChunkedJudgeLogger;
  /**
   * Optional embedder used to collapse semantically near-duplicate memories
   * after the title-match dedupe pass. When omitted, only title-match dedupe
   * is applied.
   */
  embedder?: Embedder;
  /** Cosine similarity threshold for near-duplicate grouping. Defaults to 0.85. */
  semanticDedupeThreshold?: number;
}

type T2ExtractionJudge = (transcript: string) => Promise<T2MemoryExtraction[]>;

export interface T2PromotionWorker {
  tick(): Promise<void>;
}

interface JudgeChoice {
  message?: { content?: string };
}

interface JudgeResponse {
  choices?: JudgeChoice[];
}

export function createT2PromotionWorker(opts: PromotionWorkerOpts): T2PromotionWorker {
  // If no LLM judge is configured (no PENUMBRA_SIRIUS_BASE_URL / SIRIUS_URL,
  // and no override passed in), short-circuit to a no-op worker. The previous
  // behavior — defaulting to http://localhost:8000 — collided with ChromaDB's
  // default port on common dev setups and produced an unbounded stream of
  // "Sirius returned 404" warnings every cycle.
  let activePool: JudgePool | null = null;
  const rawJudge =
    opts.llm ??
    resolveT2ExtractionJudge(opts.services, (pool) => {
      activePool = pool;
    });
  if (!rawJudge) {
    opts.services.log.info(
      "no PENUMBRA_SIRIUS_BASE_URL/SIRIUS_URL configured — t2 promotion worker disabled (set one to enable)",
    );
    return {
      tick(): Promise<void> {
        // No-op: judge unconfigured. Restart the daemon after setting the env var to enable.
        return Promise.resolve();
      },
    };
  }
  const judge = wrapJudgeWithChunking({
    judge: rawJudge,
    log: opts.services.log,
    embedder: opts.services.embedder,
  });

  const t2 = new T2Promotion({
    db: opts.services.db,
    embedder: opts.services.embedder,
    clock: opts.services.clock,
    uuid: opts.services.uuid,
    llm: judge,
  });

  const minEvents = opts.minEvents ?? 5;

  const handleRollupError = (err: unknown, rollupId: string, remaining: number): boolean => {
    if (isJudgeUnreachable(err)) {
      opts.services.log.warn(
        { err: err instanceof Error ? err.message : String(err), remaining },
        "t2 promotion: LLM judge unreachable — skipping remaining rollups this cycle",
      );
      return true;
    }
    opts.services.log.warn({ rollupId, err }, "t2 promotion: failed to promote rollup, skipping");
    return false;
  };

  const promoteOne = async (rollupId: string): Promise<void> => {
    const count = await t2.promoteRollup(rollupId);
    if (count > 0) {
      opts.services.log.info({ rollupId, count }, "t2 promotion: promoted session to memories");
    }
  };

  // Cycle-scoped circuit breaker: once we see a connection failure on the first
  // rollup of a tick, skip the rest of the rollups in that tick (no point
  // hammering an unreachable judge N times in a row). Resets every tick.
  return {
    async tick(): Promise<void> {
      if (activePool) activePool.resetTickHealth();
      const rollups = t2.detectEligibleRollups(opts.delayHours, opts.services.clock(), minEvents);
      for (let i = 0; i < rollups.length; i++) {
        const rollupId = rollups[i];
        if (!rollupId) continue;
        try {
          await promoteOne(rollupId);
        } catch (err) {
          const unreachable = handleRollupError(err, rollupId, rollups.length - i - 1);
          if (unreachable) break;
        }
      }
    },
  };
}

export function resolveT2ExtractionJudge(
  services: Services,
  onPool: (pool: JudgePool) => void = () => undefined,
): T2ExtractionJudge | null {
  return createJudgePoolFromAgentchat(services, onPool) ?? createDefaultLLMJudge(services);
}

function isContextOverflow(msg: string): boolean {
  return /exceed_context_size_error|exceeds the available context size/i.test(msg);
}

function halveChunk(chunk: string): [string, string] {
  const events = splitTranscriptOnEventBoundaries(chunk);
  if (events.length > 1) {
    const mid = Math.floor(events.length / 2);
    return [events.slice(0, mid).join("\n\n"), events.slice(mid).join("\n\n")];
  }
  const mid = Math.floor(chunk.length / 2);
  return [chunk.slice(0, mid), chunk.slice(mid)];
}

function createJudgeWithRetry(
  opts: ChunkedJudgeOpts,
): (chunk: string, depth: number) => Promise<T2MemoryExtraction[]> {
  const retryAfterOverflow = async (
    chunk: string,
    depth: number,
    msg: string,
    recurse: (chunk: string, depth: number) => Promise<T2MemoryExtraction[]>,
  ): Promise<T2MemoryExtraction[]> => {
    if (chunk.length < 4000 || depth >= 5) {
      opts.log?.warn?.(
        { err: msg, depth, chunkLength: chunk.length },
        "t2 promotion: context overflow retry exhausted; dropping chunk",
      );
      return [];
    }
    opts.log?.warn?.(
      { depth, chunkLength: chunk.length },
      "t2 promotion: context overflow; halving and retrying",
    );
    const [first, second] = halveChunk(chunk);
    const m1 = await recurse(first, depth + 1);
    const m2 = await recurse(second, depth + 1);
    return [...m1, ...m2];
  };

  const judgeWithRetry = async (chunk: string, depth: number): Promise<T2MemoryExtraction[]> => {
    try {
      return await opts.judge(chunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isContextOverflow(msg)) throw err;
      return await retryAfterOverflow(chunk, depth, msg, judgeWithRetry);
    }
  };
  return judgeWithRetry;
}

function packEventsIntoChunks(events: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  const flush = (): void => {
    if (bufLen > 0) {
      chunks.push(buf.join("\n\n"));
      buf = [];
      bufLen = 0;
    }
  };
  for (const ev of events) {
    if (ev.length > maxChars) {
      flush();
      let start = 0;
      while (start < ev.length) {
        chunks.push(ev.slice(start, start + maxChars));
        start += maxChars;
      }
      continue;
    }
    if (bufLen > 0 && bufLen + ev.length + 2 > maxChars) flush();
    buf.push(ev);
    bufLen += ev.length + 2;
  }
  flush();
  return chunks;
}

async function judgeAcrossChunks(
  chunks: string[],
  judgeWithRetry: (chunk: string, depth: number) => Promise<T2MemoryExtraction[]>,
  log: ChunkedJudgeLogger | undefined,
): Promise<T2MemoryExtraction[]> {
  const out: T2MemoryExtraction[] = [];
  for (const chunk of chunks) {
    try {
      const memories = await judgeWithRetry(chunk, 0);
      for (const memory of memories) out.push(memory);
    } catch (err) {
      log?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "t2 promotion: chunk judge failed; continuing",
      );
    }
  }
  return out;
}

export function wrapJudgeWithChunking(
  opts: ChunkedJudgeOpts,
): (transcript: string) => Promise<T2MemoryExtraction[]> {
  const envVal = parseInt(process.env.PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK ?? "", 10);
  const defaultMax = !isNaN(envVal) && envVal > 0 ? envVal : 80_000;
  const maxChars = opts.maxCharsPerChunk ?? defaultMax;
  const judgeWithRetry = createJudgeWithRetry(opts);

  return async (transcript: string): Promise<T2MemoryExtraction[]> => {
    let finalMemories: T2MemoryExtraction[];

    if (transcript.length <= maxChars) {
      finalMemories = await judgeWithRetry(transcript, 0);
    } else {
      const events = splitTranscriptOnEventBoundaries(transcript);
      const chunks = packEventsIntoChunks(events, maxChars);
      opts.log?.info?.(
        { chunks: chunks.length, totalChars: transcript.length, maxChars },
        "t2 promotion: transcript chunked",
      );
      finalMemories = await judgeAcrossChunks(chunks, judgeWithRetry, opts.log);
    }

    const titleDeduped = dedupeByTitle(finalMemories);
    if (!opts.embedder || titleDeduped.length < 2) return titleDeduped;
    try {
      return await dedupeBySemanticSimilarity(
        titleDeduped,
        opts.embedder,
        opts.semanticDedupeThreshold ?? 0.85,
      );
    } catch (err) {
      opts.log?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "t2 promotion: semantic dedupe failed; returning title-deduped memories",
      );
      return titleDeduped;
    }
  };
}

/**
 * Many local LLMs (gemma, llama, etc.) wrap JSON output in markdown code
 * fences even when response_format='json_object' is set, because the underlying
 * llama.cpp servers don't strictly enforce JSON mode. Strip an outer ```json
 * ... ``` (or ``` ... ```) wrapper if present so JSON.parse can succeed.
 * Returns the input unchanged if no fence is detected.
 */
// Backreference-based capture group flagged by regexp/no-unused-capturing-group;
// rewritten as two alternations with explicit end tags to avoid the warning.
const REASONING_TAGS_PATTERN = /<think>[\s\S]*?<\/think>\s*|<reasoning>[\s\S]*?<\/reasoning>\s*/gi;

function stripReasoningTags(content: string): string {
  return content.replaceAll(REASONING_TAGS_PATTERN, "");
}

// Constructed from String.fromCharCode so the regex literal does not contain
// a raw control byte (no-control-regex).  is the ANSI ESC byte.
const ANSI_CSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");
const ANSI_CSI_FALLBACK_PATTERN = /(?:^|\s)\[[0-9;]+[A-Za-z]/g;
// Outer json fence; \s+ on the trailing whitespace + bounded inner span keep the
// matcher away from polynomial backtracking flagged by
// regexp/no-super-linear-backtracking. exec is used instead of String#match for
// @typescript-eslint/prefer-regexp-exec compliance.
const JSON_FENCE_PATTERN = /^```(?:json|JSON)?\n?([\s\S]*?)\n?```$/;
const NON_ANSWER_PATTERN = /^(?:none|null|n\/?a|nothing|empty)\.?$/i;

export function stripJsonFence(content: string): string {
  const detagged = stripReasoningTags(content).trim();
  // Models sometimes emit a single-word non-answer ("none", "null", "n/a")
  // when they decide nothing should be extracted. Coerce to the empty-array
  // shape so the caller can parse + validate uniformly instead of failing.
  if (NON_ANSWER_PATTERN.test(detagged)) {
    return '{"memories":[]}';
  }
  // Strip ANSI CSI sequences before brace extraction so the JSON span matcher
  // sees clean braces even when a judge emits terminal control codes.
  const stripped = detagged
    .replaceAll(ANSI_CSI_PATTERN, "")
    .replaceAll(ANSI_CSI_FALLBACK_PATTERN, " ");
  const fenced = JSON_FENCE_PATTERN.exec(stripped);
  if (fenced) {
    const inner = fenced[1];
    if (inner !== undefined) return inner.trim();
  }
  // Fallback: when transcripts contain prompt-injected wrappers
  // (e.g. claude-mem's "wrap responses in <summary>...</summary>" instruction)
  // the model dutifully wraps the JSON in arbitrary tags. Extract the
  // outermost {...} span instead of failing on the leading tag.
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return stripped.slice(firstBrace, lastBrace + 1);
  }
  return stripped;
}

function isJudgeUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // ECONNREFUSED / DNS failure / aborted-by-timeout / Sirius non-2xx all flagged.
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|aborted|fetch failed|Sirius returned/i.test(msg);
}

function splitTranscriptOnEventBoundaries(transcript: string): string[] {
  const events = transcript
    .split(/\n\n(?=User: |Assistant: )/)
    .map((e) => e.trim())
    .filter(Boolean);
  return events.length > 0 ? events : [transcript.trim()].filter(Boolean);
}

function dedupeByTitle(memories: T2MemoryExtraction[]): T2MemoryExtraction[] {
  const seen = new Set<string>();
  const out: T2MemoryExtraction[] = [];
  for (const memory of memories) {
    const key = memory.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(memory);
  }
  return out;
}

interface ClusterState {
  reps: number[];
  clusterOf: number[];
}

function findClusterAssignment(
  state: ClusterState,
  vectors: Float32Array[],
  norms: number[],
  i: number,
  threshold: number,
): number {
  const vi = vectors[i];
  const ni = norms[i];
  if (!vi || ni === undefined) return -1;
  for (const r of state.reps) {
    const vr = vectors[r];
    const nr = norms[r];
    if (!vr || nr === undefined) continue;
    if (cosineSim(vi, vr, ni, nr) >= threshold) return r;
  }
  return -1;
}

function reassignCluster(state: ClusterState, oldRep: number, newRep: number): void {
  const idx = state.reps.indexOf(oldRep);
  if (idx !== -1) state.reps[idx] = newRep;
  for (let k = 0; k < state.clusterOf.length; k++) {
    if (state.clusterOf[k] === oldRep) state.clusterOf[k] = newRep;
  }
}

async function dedupeBySemanticSimilarity(
  memories: T2MemoryExtraction[],
  embedder: Embedder,
  threshold: number,
): Promise<T2MemoryExtraction[]> {
  const vectors = await embedder.embed(memories.map((m) => buildT2EmbedText(m.title, m.body)));
  // Index in `memories` of the surviving representative for each cluster.
  // clusterOf: per-input mapping to its cluster's rep index.
  const state: ClusterState = {
    reps: [],
    clusterOf: Array.from<number>({ length: memories.length }).fill(-1),
  };
  const norms = vectors.map((v) => l2norm(v));

  for (let i = 0; i < memories.length; i++) {
    const assigned = findClusterAssignment(state, vectors, norms, i, threshold);
    if (assigned === -1) {
      state.reps.push(i);
      state.clusterOf[i] = i;
      continue;
    }
    state.clusterOf[i] = assigned;
    const current = memories[i];
    const winner = memories[assigned];
    if (current && winner && current.body.length > winner.body.length) {
      reassignCluster(state, assigned, i);
    }
  }

  // Preserve original order of representatives.
  const repSet = new Set(state.reps);
  return memories.filter((_, i) => repSet.has(i));
}

function l2norm(v: Float32Array): number {
  let s = 0;
  for (const value of v) s += value * value;
  return Math.sqrt(s);
}

function cosineSim(a: Float32Array, b: Float32Array, na: number, nb: number): number {
  if (na === 0 || nb === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) continue;
    dot += av * bv;
  }
  return dot / (na * nb);
}

export function parseJudgeResponse(content: string): T2MemoryExtraction[] {
  // Some transcripts produce structurally invalid JSON from the judge
  // (duplicate keys with mismatched closing braces, unbalanced arrays from
  // mid-output truncation, etc). Returning [] on parse failure marks the
  // rollup promoted with 0 extractions instead of failed-and-retried; we
  // accept that some transcripts are unparseable rather than burning the
  // 5-attempt retry budget on each one.
  let parsed: { memories?: unknown };
  try {
    parsed = JSON.parse(stripJsonFence(content)) as { memories?: unknown };
  } catch {
    return [];
  }
  const extractions = parsed.memories;
  if (!Array.isArray(extractions)) {
    return [];
  }
  return extractions as T2MemoryExtraction[];
}

export function createDefaultLLMJudge(
  services: Services,
): ((transcript: string) => Promise<T2MemoryExtraction[]>) | null {
  const url = process.env.PENUMBRA_SIRIUS_BASE_URL ?? process.env.SIRIUS_URL;
  if (!url) return null;
  const model = process.env.PENUMBRA_JUDGE_MODEL ?? process.env.PENUMBRA_SIRIUS_MODEL ?? "gpt-4o";
  const token = process.env.PENUMBRA_SIRIUS_TOKEN ?? "";
  services.log.info({ url, model, hasToken: Boolean(token) }, "t2 promotion: LLM judge configured");

  return async (transcript: string): Promise<T2MemoryExtraction[]> => {
    const timeoutMs = getJudgeTimeoutMs();
    try {
      const prompt = T2_PROMOTION_PROMPT.replace("{{TRANSCRIPT}}", transcript);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 16384,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`Sirius returned ${String(res.status)}: ${await res.text()}`);
      }

      const json = (await res.json()) as JudgeResponse;
      const content = json.choices?.[0]?.message?.content;
      if (!content) return [];
      return parseJudgeResponse(content);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        const msg = `judge default timed out after ${String(timeoutMs)}ms`;
        services.log.error({ err: msg }, "LLM judge failed");
        throw new Error(msg);
      }
      services.log.error({ err }, "LLM judge failed");
      throw err;
    }
  };
}

function loadAgentChatConfigSafe(services: Services, configDir: string): AgentChatConfig | null {
  try {
    return loadAgentChatConfig();
  } catch (err) {
    services.log.warn(
      { err, configDir },
      "t2 promotion: failed to load agentchat config for judge pool",
    );
    return null;
  }
}

// Accept only a real plain object. Malformed per-seat extras are ignored so one
// bad config entry does not disable the whole judge pool.
export function extractT2JudgeRequestExtras(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const value = options?.["requestExtras"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function createJudgePoolFromAgentchat(
  services: Services,
  onPool: (pool: JudgePool) => void,
): ((transcript: string) => Promise<T2MemoryExtraction[]>) | null {
  const configDir = resolveAgentChatConfigPath();
  const cfg = loadAgentChatConfigSafe(services, configDir);
  if (!cfg) return null;

  const roleTag = process.env.PENUMBRA_JUDGE_ROLE ?? "memory-refiner";
  const judges: JudgeEntry[] = resolveRoleLlmCandidates({ roleTag, agentchatConfig: cfg }).map(
    (candidate) => {
      const requestExtras = extractT2JudgeRequestExtras(candidate.options);
      return {
        name: candidate.name,
        baseUrl: candidate.baseUrl,
        apiKey: candidate.auth.source === "bearer" ? candidate.auth.token : "",
        model: candidate.model,
        caPath: candidate.caPath,
        ...(requestExtras ? { requestExtras } : {}),
      };
    },
  );
  if (judges.length === 0) return null;

  const pool = createJudgePool({
    judges,
    log: services.log,
    promptBuilder: (transcript) => T2_PROMOTION_PROMPT.replace("{{TRANSCRIPT}}", transcript),
    parseResponse: parseJudgeResponse,
  });
  onPool(pool);
  services.log.info(
    { count: judges.length, names: judges.map((j) => j.name) },
    "t2 promotion: judge pool configured",
  );
  return async (transcript: string): Promise<T2MemoryExtraction[]> => await pool.invoke(transcript);
}
