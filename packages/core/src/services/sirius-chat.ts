export type SiriusChatFn = (opts: {
  messages: Array<{ role: string; content: string }>;
  model: string;
}) => Promise<string>;

export function createSiriusChat(opts: {
  baseUrl: string;
  token: string;
}): SiriusChatFn {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  return async (chatOpts) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({
        model: chatOpts.model,
        messages: chatOpts.messages,
      }),
    });
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
