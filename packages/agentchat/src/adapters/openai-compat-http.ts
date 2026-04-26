import { readFileSync } from 'node:fs';
import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { resolveAdapterApiKey } from './secret.js';

export interface OpenAiCompatHttpOptions {
  baseUrl: string;        // e.g. https://192.168.68.76:7843/v1
  /** Literal API key. Use only for anonymous endpoints (`local-no-auth`) or
   *  trusted on-disk configs. Prefer apiKeyEnv/apiKeyKeychain/apiKeyFile. */
  apiKey?: string;
  apiKeyEnv?: string;
  /** macOS Keychain ref in `service/account` form, e.g. `llamactl/nvidia`. */
  apiKeyKeychain?: string;
  apiKeyFile?: string;
  model: string;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  caPath?: string;        // path to a PEM file with extra trusted CAs (for self-signed servers)
  systemPrompt?: string;  // prepended as a {role: 'system'} message
}

export class OpenAiCompatHttpAdapter implements Adapter {
  readonly kind = 'openai-compat-http';
  private readonly caPem: string | undefined;
  private readonly apiKey: string;
  constructor(private readonly opts: OpenAiCompatHttpOptions) {
    this.caPem = opts.caPath ? readFileSync(opts.caPath, 'utf8') : undefined;
    this.apiKey = resolveAdapterApiKey({
      apiKey: opts.apiKey,
      apiKeyEnv: opts.apiKeyEnv,
      apiKeyKeychain: opts.apiKeyKeychain,
      apiKeyFile: opts.apiKeyFile,
    });
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
        authorization: `Bearer ${this.apiKey}`,
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

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const messages: { role: string; content: string }[] = [];
    if (this.opts.systemPrompt) messages.push({ role: 'system', content: this.opts.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });
    const body = {
      ...(this.opts.extraBody ?? {}),
      model: this.opts.model,
      messages,
      max_tokens: this.opts.maxTokens ?? 1024,
      stream: true,
    };
    const init: any = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    };
    if (this.caPem) init.tls = { ca: this.caPem };
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status}`);
    if (!res.body) throw new Error('openai-compat-http: streaming response has no body');

    let contentText = '';
    let reasoningText = '';
    let lastModel: string | undefined;
    let lastTokensIn: number | undefined;
    let lastTokensOut: number | undefined;
    let buffer = '';
    const decoder = new TextDecoder();

    const reader = res.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]' || payload === '') continue;
            let parsed: any;
            try { parsed = JSON.parse(payload); } catch { continue; }
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              contentText += delta.content;
              yield { type: 'delta', text: delta.content };
            } else if (delta?.reasoning_content) {
              reasoningText += delta.reasoning_content;
              yield { type: 'delta', text: delta.reasoning_content };
            }
            if (parsed.usage?.prompt_tokens !== undefined) lastTokensIn = parsed.usage.prompt_tokens;
            if (parsed.usage?.completion_tokens !== undefined) lastTokensOut = parsed.usage.completion_tokens;
            if (parsed.model) lastModel = parsed.model;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    const finalText = contentText.length > 0 ? contentText : reasoningText;
    yield {
      type: 'done',
      result: {
        text: finalText,
        meta: {
          model: lastModel ?? this.opts.model,
          tokens_in: lastTokensIn,
          tokens_out: lastTokensOut,
        },
      },
    };
  }
}
