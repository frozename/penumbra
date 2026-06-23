import { FEW_SHOT_EXAMPLES, SYSTEM_PROMPT } from "./dream-rewriter-prompt-content.js";

export interface RewritePromptInput {
  title: string;
  bodyFirst200: string;
}

const BASE_PROMPT_MESSAGES = Object.freeze([
  { role: "system" as const, content: SYSTEM_PROMPT },
  ...FEW_SHOT_EXAMPLES.flatMap((example) => [
    {
      role: "user" as const,
      content: JSON.stringify({
        title: example.input.title,
        body_first_200: example.input.body_first_200,
      }),
    },
    {
      role: "assistant" as const,
      content: JSON.stringify(example.output),
    },
  ]),
]);

export function buildDreamQueryRewritePrompt(
  input: RewritePromptInput,
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    ...BASE_PROMPT_MESSAGES,
    {
      role: "user",
      content: JSON.stringify({
        title: input.title,
        body_first_200: input.bodyFirst200,
      }),
    },
  ];
}
