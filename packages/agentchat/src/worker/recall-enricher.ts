import type { Logger } from '@penumbra/core';
import type { RecallContextConfig } from '../config/types.js';
import type { PenumbraClient } from '../penumbra-client.js';

const QUERY_MAX_CHARS = 500;
const RECALL_TIMEOUT_MS = 5000;

export interface EnrichOpts {
  /** The original handoff prompt; the enricher returns the same string with a preamble prepended (or unchanged on failure). */
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
  client: Pick<PenumbraClient, 'recall'>;
  log: Logger;
  /** Override for tests; defaults to AbortSignal.timeout(RECALL_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Wraps a dispatched message with a `<recent-relevant-context>` preamble
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

    const projectFilter = opts.config.scope === 'project' && opts.projectId
      ? opts.projectId
      : null;

    let results: Awaited<ReturnType<PenumbraClient['recall']>>['results'];
    try {
      const timeoutMs = this.deps.timeoutMs ?? RECALL_TIMEOUT_MS;
      const recallPromise = this.deps.client.recall({
        query,
        project_id: projectFilter,
        limit: opts.config.k,
        min_score: 0,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`recall timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
      );
      const response = await Promise.race([recallPromise, timeoutPromise]);
      results = response.results;
    } catch (err) {
      this.deps.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'recall enrichment skipped (soft-fail)',
      );
      return opts.message;
    }

    if (!results || results.length === 0) return opts.message;

    const preamble = formatPreamble(results, opts.config.max_chars_per_result);
    return `${preamble}\n\n${opts.message}`;
  }
}

function formatPreamble(
  results: Awaited<ReturnType<PenumbraClient['recall']>>['results'],
  maxCharsPerResult: number,
): string {
  const items = results
    .map((r, i) => {
      const truncated = r.body.length > maxCharsPerResult
        ? r.body.slice(0, maxCharsPerResult) + '…'
        : r.body;
      const meta = `[#${i + 1} tier=${r.tier} score=${r.score.toFixed(3)} ts=${r.ts}]`;
      return `${meta}\n${truncated}`;
    })
    .join('\n\n');
  return [
    '<recent-relevant-context>',
    'The following snippets were recalled from past observations that are semantically related to your task. They may inform your approach but are not authoritative — verify against current code before acting on any specific claim.',
    '',
    items,
    '</recent-relevant-context>',
  ].join('\n');
}
