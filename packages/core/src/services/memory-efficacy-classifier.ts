import { z } from 'zod';
import type { SiriusChatFn } from './sirius-chat.js';

export interface Finding {
  text: string;
  severity: string | null;
  index: number;
}

export interface Classification {
  index: number;
  classification: string;
  reason: string;
}

const ClassificationSchema = z.object({
  index: z.number().int(),
  classification: z.enum([
    'missed_registration',
    'recall_miss',
    'memory_ignored',
    'not_memory_related',
  ]),
  reason: z.string(),
});

const ResponseSchema = z.array(ClassificationSchema);

function buildPrompt(findings: Finding[]): string {
  const lines = findings.map(
    (f) => `${f.index}. ${f.severity ? `[${f.severity}] ` : ''}${f.text}`,
  );
  return `Classify each finding below into one of these memory-failure buckets:

- missed_registration: the issue would have been prevented if a memory had been written but never was (no prior memory addressed this).
- recall_miss: a relevant memory existed but was not recalled at dispatch time (autoRecallForDispatch returned 0 hits, but a t2 row covers the same concept).
- memory_ignored: a relevant memory was recalled AND injected into the dispatch prompt, but the implementer disregarded it.
- not_memory_related: the finding is not related to memory efficacy.

Return JSON only — no markdown, no preamble. Schema: [{"index": <int>, "classification": "<one of the four>", "reason": "<short>"}]

Findings:
${lines.join('\n')}`;
}

export async function classifyFindings(
  findings: Finding[],
  opts: { siriusChat: SiriusChatFn; model: string },
): Promise<Classification[]> {
  if (findings.length === 0) return [];

  const results: Classification[] = [];

  for (let i = 0; i < findings.length; i += 10) {
    const batch = findings.slice(i, i + 10);
    try {
      const prompt = buildPrompt(batch);
      const raw = (await opts.siriusChat({
        messages: [{ role: 'user', content: prompt }],
        model: opts.model,
      })).trim();

      const extracted = extractJsonArray(raw);
      const parsed = ResponseSchema.safeParse(JSON.parse(extracted));
      if (parsed.success) {
        results.push(...parsed.data);
      } else {
        console.warn(
          '[memory-efficacy-classifier] parse failure for batch',
          parsed.error.issues,
        );
      }
    } catch (err) {
      console.warn(
        '[memory-efficacy-classifier] batch failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return results;
}

function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}
