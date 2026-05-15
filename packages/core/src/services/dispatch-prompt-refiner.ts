import type { SiriusChatFn } from './sirius-chat.js';

const REFINER_SYSTEM_PROMPT = `You receive a draft DISPATCH PROMPT meant for an autonomous coding agent (ACP). Your job is to reshape it so the agent does not misread it as session-bootstrap context, brainstorming material, or a request for approval.

Required output shape:
1. First sentence: imperative verb + the task in <=20 words. Examples: "Implement X.", "Spike Y end-to-end.", "Investigate Z and report findings."
2. Then 1-3 sentences of constraint: deliverable, what is in scope, what 'done' looks like.
3. If the input contains design / plan / proposal / "approved" framing, append exactly: "Design approved — execute end-to-end without proposing or asking for sign-off."
4. Then a single \`Context:\` paragraph (NOT a markdown heading) carrying the substantive context. Drop preamble, TOC framing, meta narration.

Strictly forbidden in output:
- Top-level markdown headers (lines starting with # or ##)
- Phrases like "Here is the task", "Below is", "I would like you to"
- Any content that reads as a document index or session bootstrap

Return ONLY the reshaped prompt. No preamble. No "Refined prompt:" prefix.`;

export const REFINER_INPUT_MAX_BYTES = 64 * 1024;
export const REFINER_OUTPUT_MAX_BYTES = 16 * 1024;

export type RefineErrorCode =
  | 'input_too_large'
  | 'input_blank'
  | 'output_empty'
  | 'output_too_large'
  | 'upstream_failed';

export class RefineError extends Error {
  readonly code: RefineErrorCode;
  constructor(code: RefineErrorCode, message: string) {
    super(message);
    this.name = 'RefineError';
    this.code = code;
  }
}

export interface RefineDispatchPromptOpts {
  message: string;
  chat: SiriusChatFn;
  model: string;
}

export async function refineDispatchPrompt(opts: RefineDispatchPromptOpts): Promise<string> {
  if (Buffer.byteLength(opts.message, 'utf8') > REFINER_INPUT_MAX_BYTES) {
    throw new RefineError('input_too_large', `input exceeds ${REFINER_INPUT_MAX_BYTES} bytes`);
  }
  if (opts.message.trim().length === 0) {
    throw new RefineError('input_blank', 'input is empty or whitespace-only');
  }
  let raw: string;
  try {
    raw = await opts.chat({
      model: opts.model,
      messages: [
        { role: 'system', content: REFINER_SYSTEM_PROMPT },
        { role: 'user', content: opts.message },
      ],
    });
  } catch (err) {
    throw new RefineError('upstream_failed', err instanceof Error ? err.message : 'upstream call failed');
  }
  const refined = raw.trim();
  if (refined.length === 0) {
    throw new RefineError('output_empty', 'refiner returned empty content');
  }
  if (Buffer.byteLength(refined, 'utf8') > REFINER_OUTPUT_MAX_BYTES) {
    throw new RefineError('output_too_large', `refined output exceeds ${REFINER_OUTPUT_MAX_BYTES} bytes`);
  }
  return refined;
}
