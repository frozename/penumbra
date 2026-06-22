import { readFileSync } from "node:fs";

import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";

import { resolveAdapterApiKey } from "./secret.js";

export interface OpenAiCompatHttpOptions {
  baseUrl: string; // e.g. https://192.168.68.76:7843/v1
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
  caPath?: string; // path to a PEM file with extra trusted CAs (for self-signed servers)
  systemPrompt?: string; // prepended as a {role: 'system'} message
}

// Bun's fetch supports a non-standard `tls` option for custom CA bundles.
// Extending RequestInit at the type level keeps the call sites cast-free; the
// runtime ignores the field on platforms (like Node's stock fetch) that don't
// honor it.
type FetchInitWithTls = RequestInit & {
  tls?: { ca?: string };
};

interface OpenAiChatCompletionResponse {
  choices?: { message?: { content?: string; reasoning_content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface OpenAiStreamChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface StreamAccumulator {
  contentText: string;
  reasoningText: string;
  lastModel: string | undefined;
  lastTokensIn: number | undefined;
  lastTokensOut: number | undefined;
}

export class OpenAiCompatHttpAdapter implements Adapter {
  readonly kind = "openai-compat-http";
  private readonly caPem: string | undefined;
  private readonly apiKey: string;
  constructor(private readonly opts: OpenAiCompatHttpOptions) {
    this.caPem = opts.caPath ? readFileSync(opts.caPath, "utf8") : undefined;
    this.apiKey = resolveAdapterApiKey({
      apiKey: opts.apiKey,
      apiKeyEnv: opts.apiKeyEnv,
      apiKeyKeychain: opts.apiKeyKeychain,
      apiKeyFile: opts.apiKeyFile,
    });
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = this.buildRequestBody(input, false);
    const init = this.buildRequestInit(body, input.signal);
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status.toString()}`);
    const data = (await res.json()) as OpenAiChatCompletionResponse;
    const msg = data.choices?.[0]?.message;
    const text =
      msg?.content && msg.content.length > 0 ? msg.content : (msg?.reasoning_content ?? "");
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
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = this.buildRequestBody(input, true);
    const init = this.buildRequestInit(body, input.signal);
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status.toString()}`);
    if (!res.body) throw new Error("openai-compat-http: streaming response has no body");

    const acc: StreamAccumulator = {
      contentText: "",
      reasoningText: "",
      lastModel: undefined,
      lastTokensIn: undefined,
      lastTokensOut: undefined,
    };

    yield* this.consumeSseStream(res.body, acc);

    const finalText = acc.contentText.length > 0 ? acc.contentText : acc.reasoningText;
    yield {
      type: "done",
      result: {
        text: finalText,
        meta: {
          model: acc.lastModel ?? this.opts.model,
          tokens_in: acc.lastTokensIn,
          tokens_out: acc.lastTokensOut,
        },
      },
    };
  }

  private buildRequestBody(input: DispatchInput, stream: boolean): Record<string, unknown> {
    const messages: { role: string; content: string }[] = [];
    if (this.opts.systemPrompt) messages.push({ role: "system", content: this.opts.systemPrompt });
    messages.push({ role: "user", content: input.prompt });
    return {
      ...(this.opts.extraBody ?? {}),
      model: this.opts.model,
      messages,
      max_tokens: this.opts.maxTokens ?? 1024,
      ...(stream ? { stream: true } : {}),
    };
  }

  private buildRequestInit(body: Record<string, unknown>, signal: AbortSignal): FetchInitWithTls {
    const init: FetchInitWithTls = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    };
    if (this.caPem) init.tls = { ca: this.caPem };
    return init;
  }

  private async *consumeSseStream(
    body: ReadableStream<Uint8Array>,
    acc: StreamAccumulator,
  ): AsyncIterable<DispatchEvent> {
    let buffer = "";
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const evt of parseSseEvent(event)) {
            yield* applyChunk(evt, acc);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* releaseLock can throw if the reader is already released */
      }
    }
  }
}

function parseSseEvent(event: string): OpenAiStreamChunk[] {
  const chunks: OpenAiStreamChunk[] = [];
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]" || payload === "") continue;
    try {
      chunks.push(JSON.parse(payload) as OpenAiStreamChunk);
    } catch {
      // skip malformed events
    }
  }
  return chunks;
}

function* applyChunk(chunk: OpenAiStreamChunk, acc: StreamAccumulator): Generator<DispatchEvent> {
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.content) {
    acc.contentText += delta.content;
    yield { type: "delta", text: delta.content };
  } else if (delta?.reasoning_content) {
    acc.reasoningText += delta.reasoning_content;
    yield { type: "delta", text: delta.reasoning_content };
  }
  if (chunk.usage?.prompt_tokens !== undefined) acc.lastTokensIn = chunk.usage.prompt_tokens;
  if (chunk.usage?.completion_tokens !== undefined)
    acc.lastTokensOut = chunk.usage.completion_tokens;
  if (chunk.model) acc.lastModel = chunk.model;
}
