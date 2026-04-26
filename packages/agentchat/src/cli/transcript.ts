export function buildNextPrompt(
  transcript: { agent: string; text: string }[],
  sender: string,
  replyText: string,
  opts: { maxTokens: number; projectContext?: string }
): string {
  const wrapper = `From @${sender}: ${replyText}`;
  const ctxBlock = opts.projectContext && opts.projectContext.length > 0
    ? `# Project context\n${opts.projectContext}`
    : null;

  if (transcript.length === 0) {
    return ctxBlock ? `${ctxBlock}\n\n${wrapper}` : wrapper;
  }

  const blocks = transcript.map(t => `[${t.agent}]: ${t.text}`);

  while (blocks.length > 0) {
    const parts = ctxBlock ? [ctxBlock, ...blocks, wrapper] : [...blocks, wrapper];
    const combined = parts.join('\n\n');
    const tokens = Math.ceil(combined.length / 4);
    if (tokens <= opts.maxTokens) {
      return combined;
    }
    blocks.shift();
  }

  return ctxBlock ? `${ctxBlock}\n\n${wrapper}` : wrapper;
}
