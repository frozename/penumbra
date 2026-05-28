export interface RecentResponse {
  agent: string;
  text: string;
}

export interface BuildPromptInput {
  projectContext: string;
  handoffMessage: string;
  recentResponses: RecentResponse[];
  /** approximate budget in tokens */
  tokenBudget: number;
  /** characters per token heuristic (defaults to 4) */
  charsPerToken?: number;
}

export function buildPrompt(input: BuildPromptInput): string {
  const cpt = input.charsPerToken ?? 4;
  const charBudget = Math.max(0, input.tokenBudget * cpt);
  const reserved =
    (input.projectContext ? input.projectContext.length + 4 : 0) +
    (input.handoffMessage ? input.handoffMessage.length + 4 : 0);
  let remaining = Math.max(0, charBudget - reserved);

  const tailBlocks: string[] = [];
  for (let i = input.recentResponses.length - 1; i >= 0; i--) {
    const r = input.recentResponses[i]!;
    const block = `## from ${r.agent}\n${r.text}`;
    if (block.length > remaining) break;
    tailBlocks.unshift(block);
    remaining -= block.length;
  }

  const parts: string[] = [];
  if (input.projectContext) parts.push(`## project context\n${input.projectContext}`);
  if (tailBlocks.length) parts.push(...tailBlocks);
  if (input.handoffMessage) parts.push(`## current message\n${input.handoffMessage}`);
  return parts.join("\n\n");
}
