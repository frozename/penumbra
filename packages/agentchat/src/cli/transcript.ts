export function buildNextPrompt(
  transcript: { agent: string; text: string }[],
  sender: string,
  replyText: string,
  opts: { maxTokens: number }
): string {
  const wrapper = `From @${sender}: ${replyText}`;
  if (transcript.length === 0) return wrapper;

  const blocks = transcript.map(t => `[${t.agent}]: ${t.text}`);
  
  while (blocks.length > 0) {
    const combined = [...blocks, wrapper].join('\n\n');
    const tokens = Math.ceil(combined.length / 4);
    if (tokens <= opts.maxTokens) {
      return combined;
    }
    blocks.shift();
  }

  return wrapper;
}