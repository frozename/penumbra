import {
  FEW_SHOT_EXAMPLES,
  SYSTEM_PROMPT,
  type RewriteResponse,
} from './dream-rewriter-prompt-content.js';

export interface BuildRewritePromptInput {
  title: string;
  bodyFirst200: string;
}

export function buildDreamQueryRewritePrompt(input: BuildRewritePromptInput): {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
} {
  return {
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      ...FEW_SHOT_EXAMPLES.flatMap((example) => [
        {
          role: 'user' as const,
          content: JSON.stringify({
            title: example.input.title,
            body_first_200: example.input.body_first_200,
          }),
        },
        {
          role: 'assistant' as const,
          content: JSON.stringify(example.output),
        },
      ]),
      {
        role: 'user',
        content: JSON.stringify({
          title: input.title,
          body_first_200: input.bodyFirst200,
        }),
      },
    ],
  };
}
