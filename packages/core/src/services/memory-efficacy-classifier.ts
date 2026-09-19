import { z } from "zod";

import type { JudgeChatFn } from "./judge-chat.js";

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

export const MEMORY_EFFICACY_BUCKETS = [
  "missed_registration",
  "recall_miss",
  "memory_ignored",
  "not_memory_related",
] as const;
export type MemoryEfficacyBucket = (typeof MEMORY_EFFICACY_BUCKETS)[number];

export const MEMORY_EFFICACY_BUCKET_DEFINITIONS: Readonly<Record<MemoryEfficacyBucket, string>> = {
  missed_registration:
    "the finding shows the same defect class was hit or fixed before in this repository (a stated recurrence or a cited prior fix) and no memory recorded that lesson",
  recall_miss:
    "the finding states that a relevant memory existed but was not recalled for the dispatch",
  memory_ignored:
    "the finding states that a relevant memory was recalled into the dispatch prompt and the implementer disregarded it",
  not_memory_related:
    "the default bucket; choose any other only when the finding text itself gives evidence of a memory-efficacy failure",
};

const ClassificationSchema = z.object({
  findingId: z.string().min(1),
  classification: z.enum(MEMORY_EFFICACY_BUCKETS),
  reason: z.string(),
});

const ResponseSchema = z.array(ClassificationSchema);

// Keep batches at 5: the current judge model is only stable on these verbose
// reason strings at this size. Raising it should come with a larger-context
// judge; the reader's DB insert batch size is separate from this LLM call size.
const CLASSIFIER_BATCH_SIZE = 5;

function buildPrompt(findings: Finding[]): string {
  const lines = findings.map(
    (f) => `${f.findingId}. ${f.severity ? `[${f.severity}] ` : ""}${f.text}`,
  );
  const bucketLines = MEMORY_EFFICACY_BUCKETS.map(
    (bucket) => `- ${bucket}: ${MEMORY_EFFICACY_BUCKET_DEFINITIONS[bucket]}`,
  ).join("\n");
  return `Classify each finding below into one of these memory-failure buckets:

${bucketLines}

Rules:
- not_memory_related is the default. Choose another bucket only when the finding text itself gives evidence of a memory-efficacy failure.
- A defect in the memory subsystem's own code (ingestion, ranking, recall or injection code) is a code defect and is not_memory_related.
- Without recall facts in the finding text (hit counts, injected memory ids), never answer recall_miss or memory_ignored.

Return JSON only — no markdown, no preamble. Schema: [{"findingId": "<string>", "classification": "<one of the four>", "reason": "<= 80 chars, fragment, no clauses>"}]

Worked examples (read these first):

Example 1 → not_memory_related
Finding: A worker timeout drops the ingestion job before the memory event is persisted to the store.
{"classification":"not_memory_related","reason":"Defect in ingestion code is a code defect, not a memory failure."}

Example 2 → not_memory_related
Finding: The ranker uses a hard threshold and rejects all candidates below score 0.7, including the only relevant memory for the current dispatch.
{"classification":"not_memory_related","reason":"Defect in ranking code is a code defect, not a memory failure."}

Example 3 → not_memory_related
Finding: A formatting bug wraps the recalled instruction in quotes, so the model treats it as reported speech instead of guidance during execution.
{"classification":"not_memory_related","reason":"Defect in injection code is a code defect, not a memory failure."}

Example 4 → not_memory_related
Finding: The handoff schema documents a claimed_by field that the writer never populates, so consumers read stale nulls.
{"classification":"not_memory_related","reason":"Drifted contract field is a code defect, not a memory failure."}

Example 5 → not_memory_related
Finding: Under memory pressure the page cache evicts the index pages, so lookups fall back to disk scans.
{"classification":"not_memory_related","reason":"Memory here means RAM/page cache, not the t2 memory store."}

Example 6 → missed_registration
Finding: This dispatch hit the same null-claim race that was fixed here in March, and no memory recorded that earlier fix.
{"classification":"missed_registration","reason":"Stated recurrence of a prior fix with no memory recorded."}

---

Now classify these findings:

Findings:
${lines.join("\n")}`;
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
      const raw = (
        await opts.judgeChat({
          messages: [{ role: "user", content: prompt }],
          model: opts.model,
        })
      ).trim();

      const extracted = extractJsonArray(raw);
      const parsed = ResponseSchema.safeParse(JSON.parse(extracted));
      if (parsed.success) {
        results.push(
          ...parsed.data.map((row) => ({
            ...row,
            raw_response_json: raw,
          })),
        );
      } else {
        console.warn("[memory-efficacy-classifier] parse failure for batch", parsed.error.issues);
      }
    } catch (err) {
      console.warn(
        "[memory-efficacy-classifier] batch failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return results;
}

function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}
