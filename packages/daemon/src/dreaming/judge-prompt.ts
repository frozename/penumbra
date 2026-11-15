// Shared text of the dreaming judge prompt. v1 places a "Memory kind" line
// between the preamble and the body; the v2 P1 prompt omits it.
export const DREAMING_JUDGE_PROMPT_PREAMBLE = `You are a memory quality judge deciding whether a candidate memory record should be promoted to long-term storage.

Return promote: false when the content is ephemeral: one-time observations ("X passed", "task #5 created"), session-specific events, literal system/dispatch prompts ("You are X, a long-lived agent...", "# Operating rules", "IMPLEMENTER MODE"), or anything that won't be true in 30 days. Return promote: true ONLY for durable knowledge: design decisions, project facts, user preferences, conventions, rules, debugging findings, gotchas, traps.`;

export const DREAMING_JUDGE_PROMPT_OUTPUT = `Output ONLY valid JSON — no prose, no code fences, no wrapper tags:
{"promote": <boolean>, "confidence": <number 0.0-1.0>, "rationale": "<one sentence>"}`;
