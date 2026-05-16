import { z } from 'zod';
import type { JudgeChatFn } from './judge-chat.js';

export interface Finding {
  text: string;
  severity: string | null;
  findingId: string;
  index: number;
}

export interface Classification {
  findingId: string;
  classification: string;
  reason: string;
  raw_response_json: string;
}

const ClassificationSchema = z.object({
  findingId: z.string().min(1),
  classification: z.enum([
    'missed_registration',
    'recall_miss',
    'memory_ignored',
    'not_memory_related',
  ]),
  reason: z.string(),
});

const ResponseSchema = z.array(ClassificationSchema);

// Keep batches at 5: the current judge model is only stable on these verbose
// reason strings at this size. Raising it should come with a larger-context
// judge; the reader's DB insert batch size is separate from this LLM call size.
const CLASSIFIER_BATCH_SIZE = 5;

function buildPrompt(findings: Finding[]): string {
  const lines = findings.map(
    (f) => `${f.findingId}. ${f.severity ? `[${f.severity}] ` : ''}${f.text}`,
  );
  return `Classify each finding below into one of these memory-failure buckets:

- missed_registration: the issue would have been prevented if a memory had been written but never was (no prior memory addressed this).
- recall_miss: a relevant memory existed but was not recalled at dispatch time (autoRecallForDispatch returned 0 hits, but a t2 row covers the same concept).
- memory_ignored: a relevant memory was recalled AND injected into the dispatch prompt, but the implementer disregarded it.
- not_memory_related: the finding is not related to memory efficacy.

Return JSON only — no markdown, no preamble. Schema: [{"findingId": "<string>", "classification": "<one of the four>", "reason": "<= 80 chars, fragment, no clauses>"}]

Worked examples (read these first):

Example 1 → missed_registration
Finding: A worker timeout drops the ingestion job before the memory event is persisted to the store.
{"classification":"missed_registration","reason":"Queue drops before persistence — the memory event would have existed, but was never written."}

Example 2 → recall_miss
Finding: The ranker uses a hard threshold and rejects all candidates below score 0.7, including the only relevant memory for the current dispatch.
{"classification":"recall_miss","reason":"A relevant memory existed but the ranker filtered it out before recall."}

Example 3 → memory_ignored
Finding: A formatting bug wraps the recalled instruction in quotes, so the model treats it as reported speech instead of guidance during execution.
{"classification":"memory_ignored","reason":"Memory was recalled and present in the prompt but the model did not act on it."}

---

Now classify this finding:

Findings:
${lines.join('\n')}`;
}

export async function classifyFindings(
  findings: Finding[],
  opts: { judgeChat: JudgeChatFn; model: string },
): Promise<Classification[]> {
  if (findings.length === 0) return [];

  const results: Classification[] = [];

  for (let i = 0; i < findings.length; i += CLASSIFIER_BATCH_SIZE) {
    const batch = findings.slice(i, i + CLASSIFIER_BATCH_SIZE);
    try {
      const prompt = buildPrompt(batch);
      const raw = (await opts.judgeChat({
        messages: [{ role: 'user', content: prompt }],
        model: opts.model,
      })).trim();

      const extracted = extractJsonArray(raw);
      const parsed = ResponseSchema.safeParse(JSON.parse(extracted));
      if (parsed.success) {
        results.push(...parsed.data.map((row) => ({
          ...row,
          raw_response_json: raw,
        })));
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
