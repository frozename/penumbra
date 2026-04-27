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
  const t2 = new T2Promotion({
    db: opts.services.db,
    embedder: opts.services.embedder,
    clock: opts.services.clock,
    uuid: opts.services.uuid,
    llm: opts.llm ?? createDefaultLLMJudge(opts.services),
  });

  let lastEnv: string | undefined;
  let cachedMinEvents: number = 5;

  return {
    async tick(): Promise<void> {
      const currentEnv = process.env.MEMORY_PROMOTION_MIN_EVENTS;
      if (currentEnv !== lastEnv) {
        lastEnv = currentEnv;
        cachedMinEvents = currentEnv ? parseInt(currentEnv, 10) : 5;
      }
      const minEvents = opts.minEvents ?? cachedMinEvents;

      const rollups = t2.detectEligibleRollups(opts.delayHours, opts.services.clock(), minEvents);
      for (const rollupId of rollups) {
        try {
          const count = await t2.promoteRollup(rollupId);
          if (count > 0) {
            opts.services.log.info({ rollupId, count }, 't2 promotion: promoted session to memories');
          }
        } catch (err) {
          opts.services.log.warn({ rollupId, err }, 't2 promotion: failed to promote rollup, skipping');
        }
      }
    },
  };
}

function createDefaultLLMJudge(services: Services) {
  return async (transcript: string): Promise<T2MemoryExtraction[]> => {
    const url = process.env.PENUMBRA_SIRIUS_BASE_URL || process.env.SIRIUS_URL || 'http://localhost:8000';
    const model = process.env.PENUMBRA_JUDGE_MODEL || process.env.PENUMBRA_SIRIUS_MODEL || 'gpt-4o';
    const token = process.env.PENUMBRA_SIRIUS_TOKEN || '';
    
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

      const parsed = JSON.parse(content);
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
