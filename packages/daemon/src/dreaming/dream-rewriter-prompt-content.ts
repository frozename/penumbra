import { z } from 'zod';

export const REWRITE_RESPONSE_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query'), query: z.string().min(1) }),
  z.object({ kind: z.literal('skip'), reason: z.string().min(1) }),
]);

export type RewriteResponse = z.infer<typeof REWRITE_RESPONSE_SCHEMA>;

export const SYSTEM_PROMPT = '<placeholder — Phase 4 fills this in>';

export interface FewShotExample {
  input: { title: string; body_first_200: string };
  output: RewriteResponse;
}

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [];

export const REWRITER_MODEL = 'granite-4.1-3b';
