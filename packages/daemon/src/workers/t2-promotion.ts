import type { Services } from '@penumbra/core';
import { T2Promotion, type T2MemoryExtraction } from '@penumbra/core';

export const T2_PROMOTION_PROMPT = `
Extract 0-N persistent semantic facts from this session transcript.
Persistent facts are things about the user, their project, their preferences, or important decisions made.
Avoid transient facts like "the user ran a command" or "the user fixed a lint error" unless they reveal a permanent preference or project rule.
Focus on things that would be useful to remember in a future session to provide better context.

IMPORTANT: Return ONLY a valid JSON object with a "memories" key containing an array of memory objects.
Each memory object must have:
- title: string (short, descriptive)
- body: string (the fact or knowledge itself)
- kind: "fact" | "preference" | "decision" | "knowledge"
- metadata: object (optional, any extra structured data)

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
  const judge = opts.llm ?? createDefaultLLMJudge(opts.services);
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
        }),
      });

      if (!res.ok) {
        throw new Error(`Sirius returned ${res.status}: ${await res.text()}`);
      }

      const json = await res.json() as any;
      const content = json.choices[0]?.message?.content;
      if (!content) return [];

      const parsed = JSON.parse(stripJsonFence(content));
      const extractions = parsed.memories;

      if (!Array.isArray(extractions)) {
        services.log.warn({ content }, 'LLM judge returned non-array memories');
        return [];
      }

      return extractions;
    } catch (err) {
      services.log.error({ err }, 'LLM judge failed');
      throw err;
    }
  };
}
