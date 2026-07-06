import { ValuePatternRedactor, type ValuePatternRule, type Logger } from "@penumbra/core";

import type { RecallContextConfig } from "../config/types.js";
import type { PenumbraClient } from "../penumbra-client.js";

const QUERY_MAX_CHARS = 500;
const RECALL_TIMEOUT_MS = 5000;

/**
 * Prompt-injection-oriented pattern scan applied to recall bodies before
 * they are spliced into a dispatched agent's message. Cross-project recall
 * (scope: global) can surface any observation from any project — including
 * text that was itself captured from an attacker-controlled surface. Without
 * this guard, that text is fed verbatim into a tool-capable agent's prompt.
 *
 * Rules are fail-closed: on a hit, drop the entire recall item rather than
 * try to sanitize in-place. All rules are anchored to injection-shaped text
 * (imperative overrides, shell/pipe-exec, tool-invocation markers) — they
 * are not general-purpose secret redaction.
 */
const INJECTION_SCAN_RULES: readonly ValuePatternRule[] = [
  {
    id: "imperative_override",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^\n]{0,40}\b(?:all\s+)?(?:prior|previous|above|earlier|preceding|initial|original)\b[^\n]{0,40}\b(?:instructions?|prompts?|rules?|directives?|system\s+prompt|context)\b/gi,
    replacement: "[REDACTED:injection]",
    failClosed: true,
  },
  {
    id: "role_reassignment",
    pattern: /\byou\s+are\s+now\s+(?:a|an|the)\b[^\n]{0,80}/gi,
    replacement: "[REDACTED:role-reassignment]",
    failClosed: true,
  },
  {
    id: "chat_role_marker",
    pattern: /(?:^|\n)\s*(?:system|assistant|human|user)\s*:\s*(?=\n|$)/gi,
    replacement: "[REDACTED:role-marker]",
    failClosed: true,
  },
  {
    id: "new_directive_marker",
    pattern: /\bnew\s+(?:instructions?|task|prompt|directive|system\s+prompt)\s*:/gi,
    replacement: "[REDACTED:new-directive]",
    failClosed: true,
  },
  {
    id: "shell_pipe_exec",
    pattern:
      /(?:curl|wget|fetch)\b[^\n|]{0,200}\|\s*(?:sh|bash|zsh|dash|python\d?|ruby|perl|node)\b/gi,
    replacement: "[REDACTED:shell-pipe]",
    failClosed: true,
  },
  {
    id: "tool_call_marker",
    pattern:
      /<\s*(?:antml:)?function_calls\b|<\s*(?:antml:)?invoke\b|<\s*tool_use\b|<\|\s*tool_call\s*\|>|<\|\s*im_start\s*\|>/gi,
    replacement: "[REDACTED:tool-marker]",
    failClosed: true,
  },
] as const;

const INJECTION_REDACTOR = new ValuePatternRedactor(INJECTION_SCAN_RULES);

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

    const safe = this.scanForInjection(items);
    if (safe.length === 0) return opts.message;

    const preamble = formatPreamble(safe, opts.config.max_chars_per_result);
    return `${opts.message}\n\n${preamble}`;
  }

  /**
   * Fail-closed injection scan. Drops any item whose body trips a rule.
   * Any thrown error (regex engine misbehavior, unexpected redactor bug)
   * drops that item without escaping — recall enrichment must never block
   * dispatch, and it must never emit un-scanned content on failure.
   */
  private scanForInjection(items: PreambleItem[]): PreambleItem[] {
    const kept: PreambleItem[] = [];
    for (const item of items) {
      try {
        const { hits } = INJECTION_REDACTOR.redactString(item.body);
        if (hits.length > 0) {
          this.deps.log.warn(
            {
              rule_ids: hits.map((h) => h.rule_id),
              tier: item.tier,
              ts: item.ts,
            },
            "recall item dropped by injection scan",
          );
          continue;
        }
        kept.push(item);
      } catch (err) {
        this.deps.log.warn(
          { err: err instanceof Error ? err.message : String(err), tier: item.tier, ts: item.ts },
          "recall injection scan errored; dropping item (soft-fail)",
        );
      }
    }
    return kept;
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
