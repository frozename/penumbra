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

export interface RefineDispatchPromptOpts {
  message: string;
  chat: SiriusChatFn;
  model: string;
}

export async function refineDispatchPrompt(opts: RefineDispatchPromptOpts): Promise<string> {
  const out = await opts.chat({
    model: opts.model,
    messages: [
      { role: 'system', content: REFINER_SYSTEM_PROMPT },
      { role: 'user', content: opts.message },
    ],
  });
  const refined = out.trim();
  if (!refined) throw new Error('dispatch-prompt-refiner: empty refined output');
  return refined;
}
