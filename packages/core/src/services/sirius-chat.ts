export type SiriusChatFn = (opts: {
  messages: Array<{ role: string; content: string }>;
  model: string;
}) => Promise<string>;

const SIRIUS_CHAT_TIMEOUT_MS = 30_000;

export function createSiriusChat(opts: {
  baseUrl: string;
  token: string;
}): SiriusChatFn {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  return async (chatOpts) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIRIUS_CHAT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({
          model: chatOpts.model,
          messages: chatOpts.messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`sirius chat: timed out after ${SIRIUS_CHAT_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`sirius chat: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('sirius chat: empty response');
    }
    return content;
  };
}
