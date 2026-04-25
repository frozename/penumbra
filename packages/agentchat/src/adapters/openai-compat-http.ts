import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';

export interface OpenAiCompatHttpOptions {
  baseUrl: string;        // e.g. https://192.168.68.76:7843/v1
  apiKey: string;
  model: string;
  maxTokens?: number;
}

export class OpenAiCompatHttpAdapter implements Adapter {
  readonly kind = 'openai-compat-http';
  constructor(private readonly opts: OpenAiCompatHttpOptions) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.opts.model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: this.opts.maxTokens ?? 1024,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      meta: {
        model: data.model ?? this.opts.model,
        tokens_in: data.usage?.prompt_tokens,
        tokens_out: data.usage?.completion_tokens,
        raw_response: data,
      },
    };
  }
}
