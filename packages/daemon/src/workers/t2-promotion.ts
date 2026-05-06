import type { Services } from '@penumbra/core';
import { T2Promotion, type T2MemoryExtraction } from '@penumbra/core';
import { loadConfig } from '@penumbra/agentchat/src/config/load.js';
import type { AgentChatConfig } from '@penumbra/agentchat/src/config/types.js';
import { resolveAgentChatConfigPath } from '../agentchat-config.js';
import { createJudgePool, type JudgeEntry, type JudgePool } from './t2-judge-pool.js';

export const T2_PROMPT_FILTER_RULE =
  'If a memory could be retrieved later by `git log`, `grep`, `find`, or just reading the code, DO NOT extract it. Memory is for things that take judgment to discover, not things that are mechanically discoverable.';

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

If nothing in the transcript clears the bar, the CORRECT answer is the literal string \`{"memories":[]}\` — an empty array. NOT the word "none", NOT "null", NOT prose explaining why nothing matched. Just \`{"memories":[]}\`. This is the right answer for chitchat, pure activity logs, and anything below the bar.

Output ONLY a valid JSON object: {"memories": [...]}. Each memory object: { title (short headline), body (the durable knowledge itself), kind ("fact" | "preference" | "decision" | "knowledge"), metadata (optional object) }. No prose. No code fence. No wrapper tags. No "none"/"null" string fallbacks.

Transcript:
{{TRANSCRIPT}}
`.trim();

export interface PromotionWorkerOpts {
  services: Services;
  delayHours: number;
  llm?: (transcript: string) => Promise<T2MemoryExtraction[]>;
  minEvents?: number;
}

export function createT2PromotionWorker(opts: PromotionWorkerOpts) {
  // If no LLM judge is configured (no PENUMBRA_SIRIUS_BASE_URL / SIRIUS_URL,
  // and no override passed in), short-circuit to a no-op worker. The previous
  // behavior — defaulting to http://localhost:8000 — collided with ChromaDB's
  // default port on common dev setups and produced an unbounded stream of
  // "Sirius returned 404" warnings every cycle.
  let activePool: JudgePool | null = null;
  const judge = opts.llm
    ?? createJudgePoolFromAgentchat(opts.services, (pool) => {
      activePool = pool;
    })
    ?? createDefaultLLMJudge(opts.services);
  if (!judge) {
    opts.services.log.info(
      'no PENUMBRA_SIRIUS_BASE_URL/SIRIUS_URL configured — t2 promotion worker disabled (set one to enable)',
    );
    return {
      async tick(): Promise<void> {
        // No-op: judge unconfigured. Restart the daemon after setting the env var to enable.
      },
    };
  }

  const t2 = new T2Promotion({
    db: opts.services.db,
    embedder: opts.services.embedder,
    clock: opts.services.clock,
    uuid: opts.services.uuid,
    llm: judge,
  });

  let lastEnv: string | undefined;
  let cachedMinEvents: number = 5;
  // Cycle-scoped circuit breaker: once we see a connection failure on the first
  // rollup of a tick, skip the rest of the rollups in that tick (no point
  // hammering an unreachable judge N times in a row). Resets every tick.
  return {
    async tick(): Promise<void> {
      if (activePool) activePool.resetTickHealth();
      const currentEnv = process.env.MEMORY_PROMOTION_MIN_EVENTS;
      if (currentEnv !== lastEnv) {
        lastEnv = currentEnv;
        cachedMinEvents = currentEnv ? parseInt(currentEnv, 10) : 5;
      }
      const minEvents = opts.minEvents ?? cachedMinEvents;

      const rollups = t2.detectEligibleRollups(opts.delayHours, opts.services.clock(), minEvents);
      let judgeUnreachable = false;
      for (const rollupId of rollups) {
        if (judgeUnreachable) break;
        try {
          const count = await t2.promoteRollup(rollupId);
          if (count > 0) {
            opts.services.log.info({ rollupId, count }, 't2 promotion: promoted session to memories');
          }
        } catch (err) {
          if (isJudgeUnreachable(err)) {
            opts.services.log.warn(
              { err: err instanceof Error ? err.message : String(err), remaining: rollups.length - rollups.indexOf(rollupId) - 1 },
              't2 promotion: LLM judge unreachable — skipping remaining rollups this cycle',
            );
            judgeUnreachable = true;
            continue;
          }
          opts.services.log.warn({ rollupId, err }, 't2 promotion: failed to promote rollup, skipping');
        }
      }
    },
  };
}

/**
 * Many local LLMs (gemma, llama, etc.) wrap JSON output in markdown code
 * fences even when response_format='json_object' is set, because the underlying
 * llama.cpp servers don't strictly enforce JSON mode. Strip an outer ```json
 * ... ``` (or ``` ... ```) wrapper if present so JSON.parse can succeed.
 * Returns the input unchanged if no fence is detected.
 */
function stripReasoningTags(content: string): string {
  return content.replace(/<(think|reasoning)>[\s\S]*?<\/\1>\s*/gi, '');
}

export function stripJsonFence(content: string): string {
  const detagged = stripReasoningTags(content).trim();
  // Models sometimes emit a single-word non-answer ("none", "null", "n/a")
  // when they decide nothing should be extracted. Coerce to the empty-array
  // shape so the caller can parse + validate uniformly instead of failing.
  if (/^(none|null|n\/?a|nothing|empty)\.?$/i.test(detagged)) {
    return '{"memories":[]}';
  }
  const fenced = detagged.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1]!.trim();
  // Fallback: when transcripts contain prompt-injected wrappers
  // (e.g. claude-mem's "wrap responses in <summary>...</summary>" instruction)
  // the model dutifully wraps the JSON in arbitrary tags. Extract the
  // outermost {...} span instead of failing on the leading tag.
  const firstBrace = detagged.indexOf('{');
  const lastBrace = detagged.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return detagged.slice(firstBrace, lastBrace + 1);
  }
  return detagged;
}

function isJudgeUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // ECONNREFUSED / DNS failure / aborted-by-timeout / Sirius non-2xx all flagged.
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|aborted|fetch failed|Sirius returned/i.test(msg);
}

function parseJudgeResponse(content: string): T2MemoryExtraction[] {
  const parsed = JSON.parse(stripJsonFence(content)) as { memories?: unknown };
  const extractions = parsed.memories;
  if (!Array.isArray(extractions)) {
    return [];
  }
  return extractions;
}

function createDefaultLLMJudge(services: Services): ((transcript: string) => Promise<T2MemoryExtraction[]>) | null {
  const url = process.env.PENUMBRA_SIRIUS_BASE_URL || process.env.SIRIUS_URL;
  if (!url) return null;
  const model = process.env.PENUMBRA_JUDGE_MODEL || process.env.PENUMBRA_SIRIUS_MODEL || 'gpt-4o';
  const token = process.env.PENUMBRA_SIRIUS_TOKEN || '';
  services.log.info({ url, model, hasToken: Boolean(token) }, 't2 promotion: LLM judge configured');

  return async (transcript: string): Promise<T2MemoryExtraction[]> => {
    try {
      const prompt = T2_PROMOTION_PROMPT.replace('{{TRANSCRIPT}}', transcript);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: 4096,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        throw new Error(`Sirius returned ${res.status}: ${await res.text()}`);
      }

      const json = await res.json() as any;
      const content = json.choices[0]?.message?.content;
      if (!content) return [];
      return parseJudgeResponse(content);
    } catch (err) {
      services.log.error({ err }, 'LLM judge failed');
      throw err;
    }
  };
}

function createJudgePoolFromAgentchat(
  services: Services,
  onPool: (pool: JudgePool) => void,
): ((transcript: string) => Promise<T2MemoryExtraction[]>) | null {
  const configPath = resolveAgentChatConfigPath();
  let cfg: AgentChatConfig;
  try {
    cfg = loadConfig(configPath);
  } catch (err) {
    services.log.warn({ err, configPath }, 't2 promotion: failed to load agentchat config for judge pool');
    return null;
  }

  const roleTag = process.env.PENUMBRA_JUDGE_ROLE ?? 'memory-refiner';
  const eligible = (cfg.agents ?? []).filter((agent) =>
    agent.adapter === 'openai-compat-http' &&
    Array.isArray(agent.roles) &&
    agent.roles.includes(roleTag) &&
    typeof agent.options?.baseUrl === 'string' &&
    agent.options.baseUrl.length > 0,
  );
  if (eligible.length === 0) return null;

  const judges: JudgeEntry[] = eligible.map((agent) => ({
    name: agent.name,
    baseUrl: agent.options.baseUrl as string,
    apiKey: (agent.options.apiKey as string) ?? '',
    model: (agent.options.model as string) ?? 'local',
    caPath: agent.options.caPath as string | undefined,
  }));

  const pool = createJudgePool({
    judges,
    log: services.log,
    promptBuilder: (transcript) => T2_PROMOTION_PROMPT.replace('{{TRANSCRIPT}}', transcript),
    parseResponse: parseJudgeResponse,
  });
  onPool(pool);
  services.log.info({ count: judges.length, names: judges.map((j) => j.name) }, 't2 promotion: judge pool configured');
  return async (transcript: string) => pool.invoke(transcript);
}
