import type { Logger } from "@penumbra/core";

import type { RecallContextConfig } from "../config/types.js";
import type { PenumbraClient } from "../penumbra-client.js";

const QUERY_MAX_CHARS = 500;
const RECALL_TIMEOUT_MS = 5000;

export interface EnrichOpts {
  /** The original handoff prompt; the enricher returns the same string with recalled context appended (or unchanged on failure). */
  message: string;
  /** Per-agent recall config (already validated). */
  config: RecallContextConfig;
  /**
   * project_id used to scope recall when `config.scope === 'project'`. Pass
   * the value derived from the worktree's cwd. If null, scope falls back to
   * 'global' regardless of config (we never silently filter by null).
   */
  projectId: string | null;
}

export interface RecallEnricherDeps {
  client: Pick<PenumbraClient, "recall" | "corpusQuery">;
  log: Logger;
  /** Override for tests; defaults to AbortSignal.timeout(RECALL_TIMEOUT_MS). */
  timeoutMs?: number;
}

interface PreambleItem {
  tier: string;
  score: number;
  ts: string;
  body: string;
}

/**
 * Wraps a dispatched message with a trailing `<recent-relevant-context>` block
 * derived from a recall query against the message text. Always soft-fails:
 * any thrown error or empty result returns the message unchanged so a
 * recall outage never blocks dispatch.
 */
export class RecallEnricher {
  constructor(private readonly deps: RecallEnricherDeps) {}

  async enrich(opts: EnrichOpts): Promise<string> {
    if (!opts.config.enabled) return opts.message;

    const query = opts.message.slice(0, QUERY_MAX_CHARS).trim();
    if (!query) return opts.message;

    const items =
      typeof opts.config.scope === "string" && opts.config.scope.startsWith("corpus:")
        ? await this.queryCorpus(query, opts)
        : await this.queryRecall(query, opts);

    if (!items || items.length === 0) return opts.message;

    const preamble = formatPreamble(items, opts.config.max_chars_per_result);
    return `${opts.message}\n\n${preamble}`;
  }

  private async queryRecall(query: string, opts: EnrichOpts): Promise<PreambleItem[] | null> {
    const projectFilter = opts.config.scope === "project" && opts.projectId ? opts.projectId : null;
    try {
      const response = await this.withTimeout(
        this.deps.client.recall({
          query,
          project_id: projectFilter,
          limit: opts.config.k,
          min_score: 0,
        }),
      );
      return response.results.map((r) => ({
        tier: r.tier,
        score: r.score,
        ts: r.ts,
        body: r.body,
      }));
    } catch (err) {
      this.deps.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "recall enrichment skipped (soft-fail)",
      );
      return null;
    }
  }

  private async queryCorpus(query: string, opts: EnrichOpts): Promise<PreambleItem[] | null> {
    const corpusName = opts.config.scope.slice("corpus:".length);
    try {
      const response = await this.withTimeout(
        this.deps.client.corpusQuery({
          name: corpusName,
          query,
          limit: opts.config.k,
        }),
      );
      return response.hits.map((h) => ({ tier: "corpus", score: h.score, ts: h.ts, body: h.body }));
    } catch (err) {
      this.deps.log.warn(
        { err: err instanceof Error ? err.message : String(err), corpus: corpusName },
        "corpus recall enrichment skipped (soft-fail)",
      );
      return null;
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.deps.timeoutMs ?? RECALL_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`recall timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs).unref();
    });
    return Promise.race([promise, timeoutPromise]);
  }
}

function formatPreamble(items: PreambleItem[], maxCharsPerResult: number): string {
  const rendered = items
    .map((r, i) => {
      const truncated =
        r.body.length > maxCharsPerResult ? r.body.slice(0, maxCharsPerResult) + "…" : r.body;
      const meta = `[#${String(i + 1)} tier=${r.tier} score=${r.score.toFixed(3)} ts=${r.ts}]`;
      return `${meta}\n${truncated}`;
    })
    .join("\n\n");
  return [
    "<recent-relevant-context>",
    "The following snippets were recalled from past observations that are semantically related to your task. They may inform your approach but are not authoritative — verify against current code before acting on any specific claim.",
    "",
    rendered,
    "</recent-relevant-context>",
  ].join("\n");
}
