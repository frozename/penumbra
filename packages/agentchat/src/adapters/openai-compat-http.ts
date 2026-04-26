import { readFileSync } from 'node:fs';
import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';

export interface OpenAiCompatHttpOptions {
  baseUrl: string;        // e.g. https://192.168.68.76:7843/v1
  apiKey: string;
  model: string;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  caPath?: string;        // path to a PEM file with extra trusted CAs (for self-signed servers)
  systemPrompt?: string;  // prepended as a {role: 'system'} message
}

export class OpenAiCompatHttpAdapter implements Adapter {
  readonly kind = 'openai-compat-http';
  private readonly caPem: string | undefined;
  constructor(private readonly opts: OpenAiCompatHttpOptions) {
    this.caPem = opts.caPath ? readFileSync(opts.caPath, 'utf8') : undefined;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const messages: { role: string; content: string }[] = [];
    if (this.opts.systemPrompt) messages.push({ role: 'system', content: this.opts.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });
    const body = {
      ...(this.opts.extraBody ?? {}),
      model: this.opts.model,
      messages,
      max_tokens: this.opts.maxTokens ?? 1024,
    };
    const init: any = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    };
    if (this.caPem) init.tls = { ca: this.caPem };
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const msg = data.choices?.[0]?.message;
    const text = (msg?.content && msg.content.length > 0)
      ? msg.content
      : (msg?.reasoning_content ?? '');
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
