export type JudgeChatFn = (opts: {
  messages: Array<{ role: string; content: string }>;
  model: string;
}) => Promise<string>;

const JUDGE_CHAT_TIMEOUT_MS = 30_000;

export function createJudgeChat(opts: {
  baseUrl: string;
  model: string;
  token?: string;
}): JudgeChatFn {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  return async (chatOpts) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_CHAT_TIMEOUT_MS);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (opts.token) {
        headers.authorization = `Bearer ${opts.token}`;
      }
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: chatOpts.model,
          messages: chatOpts.messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`judge chat: timed out after ${JUDGE_CHAT_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`judge chat: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('judge chat: empty response');
    }
    return content;
  };
}
