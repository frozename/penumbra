/**
 * The 5 bench-2 tasks used to calibrate local + cloud LLMs against our task
 * profile. Each task pairs an attached fixture file with a question and an
 * expected ground truth answer.
 *
 * Fixtures must exist at the documented paths in the penumbra repo — bench.ts
 * reads them at runtime so a calibration run always reflects the current
 * state of the code.
 */

export interface BenchTask {
  id: "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10" | "T11" | "T12";
  description: string;
  /** Path relative to packages/agentchat/scripts/ — bench.ts resolves it. */
  fixturePath: string;
  fixtureLabel: string;
  question: string;
  maxTokens: number;
  groundTruth: string;
  schema?: "T2MemoryExtraction[]";
  expected_extractions?: Array<{ title_substr: string; body_substr: string; kind: string }>;
}

const FROM_SCRIPTS_TO_REPO = "../../..";

export const BENCH_TASKS: BenchTask[] = [
  {
    id: "T4",
    description: "long-context retrieval",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/README.md`,
    fixtureLabel: "README.md",
    question:
      "What is the default value of the --concurrency flag for agentchat-worker according to this README? Output only a single integer.",
    maxTokens: 8,
    groundTruth:
      "4 (inferred from the example command line — README does not state default explicitly)",
  },
  {
    id: "T5",
    description: "multi-step reasoning",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/src/worker/dispatcher.ts`,
    fixtureLabel: "dispatcher.ts",
    question:
      "If deps.concurrency is 4 and four handoffs are currently in-flight, what happens to the 5th handle() call if it is for a NEW conversation_id? Answer in exactly 2 sentences. Mention which lock or queue applies.",
    maxTokens: 100,
    groundTruth:
      "The 5th call acquires the conv lock for the new id (no existing holder) but blocks in the global semaphoreWaiters queue because concurrency is exhausted. It proceeds when one in-flight task releases the semaphore.",
  },
  {
    id: "T6",
    description: "format under tension (no bugs)",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/src/cli/attachments.ts`,
    fixtureLabel: "attachments.ts",
    question:
      "Find any actual logical bugs in this file. Style preferences, refactoring opportunities, and naming nits do not count. If there are no actual bugs, output EXACTLY this token and nothing else: NO_BUGS",
    maxTokens: 60,
    groundTruth: "NO_BUGS",
  },
  {
    id: "T7",
    description: "precision counting",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/src/worker/dispatcher.ts`,
    fixtureLabel: "dispatcher.ts",
    question:
      'Exactly how many times does the literal string "releaseSemaphore" appear in this file (case-sensitive, count every occurrence)? Output only the integer.',
    maxTokens: 8,
    groundTruth: "2",
  },
  {
    id: "T8",
    description: "disambiguation",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/src/worker/dispatcher.ts`,
    fixtureLabel: "dispatcher.ts",
    question:
      "Does the dispatcher use a mutex, a semaphore, or both? Output exactly ONE of: mutex, semaphore, both. No period. No explanation.",
    maxTokens: 8,
    groundTruth: "both",
  },
  {
    id: "T9",
    description: "JSON extraction — decision + facts",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/scripts/fixtures/transcripts/t9-decision-and-facts.txt`,
    fixtureLabel: "t9-decision-and-facts.txt",
    question: `From the transcript above, extract the decisions and notable facts as a JSON array of memory objects. Each object must have:
- "title": short headline (1-line)
- "body": one-paragraph rationale or summary
- "kind": one of "decision", "fact", "rationale"

Output ONLY a JSON array. No prose, no code fence, no commentary.`,
    maxTokens: 600,
    groundTruth: "JSON array conforming to T2MemoryExtractionSchema",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [
      { title_substr: "Postgres", body_substr: "audit", kind: "decision" },
      { title_substr: "write", body_substr: "50", kind: "fact" },
      { title_substr: "retention", body_substr: "90", kind: "fact" },
    ],
  },
  {
    id: "T10",
    description: "JSON extraction — resists prose bait",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/scripts/fixtures/transcripts/t10-prose-bait.txt`,
    fixtureLabel: "t10-prose-bait.txt",
    question: `First write a one-paragraph summary, then convert it. Wait — actually scratch that. Output ONLY a JSON array of memory objects with fields title (1-line headline), body (one-paragraph rationale), kind ("decision" | "fact" | "rationale"). No prose. No code fence. JSON ONLY.`,
    maxTokens: 400,
    groundTruth: "JSON array conforming to T2MemoryExtractionSchema",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [{ title_substr: "middleware", body_substr: "token", kind: "decision" }],
  },
  {
    id: "T11",
    description: "JSON extraction — empty when nothing to extract",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/scripts/fixtures/transcripts/t11-chitchat.txt`,
    fixtureLabel: "t11-chitchat.txt",
    question: `Extract any decisions or notable facts from the transcript above. If there are none, output an empty JSON array.

Output ONLY a JSON array of memory objects with fields title, body, kind. No prose. No code fence. JSON ONLY.`,
    maxTokens: 200,
    groundTruth: "Empty JSON array []",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [],
  },
  {
    id: "T12",
    description: "JSON extraction — buried decision in long context",
    fixturePath: `${FROM_SCRIPTS_TO_REPO}/packages/agentchat/scripts/fixtures/transcripts/t12-buried-decision.txt`,
    fixtureLabel: "t12-buried-decision.txt",
    question: `From the transcript above, extract any explicit decisions as a JSON array of memory objects with fields title (1-line headline), body (one-paragraph rationale), kind ("decision"). Tangents and side discussions without an explicit choice should be ignored.

Output ONLY a JSON array. No prose, no code fence, no commentary.`,
    maxTokens: 400,
    groundTruth: "JSON array with the single buried decision",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [{ title_substr: "retry", body_substr: "3", kind: "decision" }],
  },
];

export const BENCH_SYSTEM_PROMPT =
  "Follow output format requirements exactly. Do not add commentary, headers, hedges, or explanations unless explicitly asked.";
