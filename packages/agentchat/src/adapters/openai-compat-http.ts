import { readFileSync } from "node:fs";

import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import type { CapturePort } from "../worker/capture-port.js";

import { createDispatchAbortSignal, type DispatchAbortHandle } from "./dispatch-abort.js";
import { resolveAdapterApiKey } from "./secret.js";

export interface OpenAiCompatHttpOptions {
  baseUrl: string; // e.g. https://your-llm-node.local:7843/v1
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
  requestTimeoutMs?: number;
  capturePort?: CapturePort;
}

// Bun's fetch supports a non-standard `tls` option for custom CA bundles.
// Extending RequestInit at the type level keeps the call sites cast-free; the
// runtime ignores the field on platforms (like Node's stock fetch) that don't
// honor it.
type FetchInitWithTls = RequestInit & {
  tls?: { ca?: string };
};

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface OpenAiChatCompletionResponse {
  choices?: { message?: { content?: string; reasoning_content?: string } }[];
  usage?: OpenAiUsage;
  model?: string;
}

interface OpenAiStreamChoice {
  delta?: { content?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
}

interface OpenAiStreamChunk {
  choices: OpenAiStreamChoice[];
  usage?: OpenAiUsage;
  model?: string;
}

interface UsageMetrics {
  tokensIn?: number;
  tokensOut?: number;
  tokensInput?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  used?: number;
}

interface StreamAccumulator {
  contentText: string;
  reasoningText: string;
  lastModel: string | undefined;
  lastUsage: UsageMetrics | undefined;
  sawFinishSignal: boolean;
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
    const requestAbort = this.createRequestAbort(input.signal);
    try {
      const init = this.buildRequestInit(body, requestAbort.signal);
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status.toString()}`);
      const data = (await res.json()) as OpenAiChatCompletionResponse;
      const msg = data.choices?.[0]?.message;
      const text =
        msg?.content && msg.content.length > 0 ? msg.content : (msg?.reasoning_content ?? "");
      const usageMetrics = extractUsageMetrics(data.usage);
      this.emitUsage(usageMetrics);
      return {
        text,
        meta: {
          model: data.model ?? this.opts.model,
          ...metaFromMetrics(usageMetrics),
          raw_response: data,
        },
      };
    } catch (err) {
      this.throwTimeoutIfMatched(requestAbort);
      throw err;
    } finally {
      requestAbort.cleanup();
    }
  }

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = this.buildRequestBody(input, true);
    const requestAbort = this.createRequestAbort(input.signal);
    try {
      const init = this.buildRequestInit(body, requestAbort.signal);
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status.toString()}`);
      if (!res.body) throw new Error("openai-compat-http: streaming response has no body");

      const acc: StreamAccumulator = {
        contentText: "",
        reasoningText: "",
        lastModel: undefined,
        lastUsage: undefined,
        sawFinishSignal: false,
      };

      yield* this.consumeSseStream(res.body, acc);

      const finalText = acc.contentText.length > 0 ? acc.contentText : acc.reasoningText;
      if (finalText.length === 0) {
        throw new Error("openai-compat-http: streaming response ended with no content");
      }
      if (!acc.sawFinishSignal) {
        throw new Error("openai-compat-http: streaming response ended without a finish signal");
      }
      this.emitUsage(acc.lastUsage);
      // Surface reasoning_content separately when we also assembled real content
      // — otherwise downstream callers would lose the thinking trace entirely.
      // When content was empty we already returned reasoningText as the body, so
      // omit the duplicate channel in that case.
      const reasoningSidecar =
        acc.contentText.length > 0 && acc.reasoningText.length > 0
          ? { reasoning_content: acc.reasoningText }
          : {};
      yield {
        type: "done",
        result: {
          text: finalText,
          meta: {
            model: acc.lastModel ?? this.opts.model,
            ...metaFromMetrics(acc.lastUsage),
            ...reasoningSidecar,
          },
        },
      };
    } catch (err) {
      this.throwTimeoutIfMatched(requestAbort);
      throw err;
    } finally {
      requestAbort.cleanup();
    }
  }

  private emitUsage(metrics: UsageMetrics | undefined): void {
    if (metrics?.used === undefined) return;
    this.opts.capturePort?.emit({
      kind: "usage_update",
      used: metrics.used,
      ...(metrics.tokensInput !== undefined ? { tokens_input: metrics.tokensInput } : {}),
      ...(metrics.tokensCacheRead !== undefined
        ? { tokens_cache_read: metrics.tokensCacheRead }
        : {}),
      ...(metrics.tokensCacheWrite !== undefined
        ? { tokens_cache_write: metrics.tokensCacheWrite }
        : {}),
    });
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

  private createRequestAbort(parent: AbortSignal): DispatchAbortHandle {
    return createDispatchAbortSignal(
      parent,
      this.opts.requestTimeoutMs ?? 0,
      (timeout) => new Error(`openai-compat-http request timed out after ${timeout.toString()}ms`),
    );
  }

  private throwTimeoutIfMatched(requestAbort: DispatchAbortHandle): never | void {
    if (requestAbort.timeoutError && requestAbort.signal.aborted) {
      throw requestAbort.timeoutError;
    }
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
          yield* applySseEvent(event, acc);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        yield* applySseEvent(buffer, acc);
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

function* applySseEvent(event: string, acc: StreamAccumulator): Generator<DispatchEvent> {
  const parsed = parseSseEvent(event);
  if (!parsed) return;
  if (parsed.done) {
    acc.sawFinishSignal = true;
    return;
  }
  yield* applyChunk(parsed.chunk, acc);
}

type SseParseResult = { done: true } | { chunk: OpenAiStreamChunk; done: false };

type JsonRecord = Record<string, unknown>;

function parseSseEvent(event: string): SseParseResult | undefined {
  const payload = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (payload.length === 0) return undefined;
  if (payload === "[DONE]") return { done: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("openai-compat-http: streaming SSE payload is not valid JSON");
  }

  const providerError = extractProviderError(parsed);
  if (providerError) {
    throw new Error(`openai-compat-http: streaming provider error: ${providerError}`);
  }
  if (!isOpenAiStreamChunk(parsed)) {
    throw new Error("openai-compat-http: streaming SSE payload is not a chat chunk");
  }
  return { chunk: parsed, done: false };
}

function* applyChunk(chunk: OpenAiStreamChunk, acc: StreamAccumulator): Generator<DispatchEvent> {
  const delta = chunk.choices[0]?.delta;
  if (
    chunk.choices.some(
      (choice) => choice.finish_reason !== undefined && choice.finish_reason !== null,
    )
  ) {
    acc.sawFinishSignal = true;
  }
  if (delta?.content) {
    acc.contentText += delta.content;
    yield { type: "delta", text: delta.content };
  } else if (delta?.reasoning_content) {
    acc.reasoningText += delta.reasoning_content;
    yield { type: "delta", text: delta.reasoning_content };
  }
  if (chunk.usage) acc.lastUsage = extractUsageMetrics(chunk.usage);
  if (chunk.model) acc.lastModel = chunk.model;
}

function extractProviderError(value: unknown): string | undefined {
  if (!isRecord(value) || !("error" in value)) return undefined;
  return stringifyErrorDetail(value.error);
}

function stringifyErrorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const message = value.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  const json = JSON.stringify(value);
  return json && json.length > 0 ? json : "provider returned an error payload";
}

function isOpenAiStreamChunk(value: unknown): value is OpenAiStreamChunk {
  if (!isRecord(value)) return false;
  const choices = value.choices;
  if (!Array.isArray(choices)) return false;
  if (choices.length === 0 && value.usage === undefined) return false;
  if (!choices.every(isOpenAiStreamChoice)) return false;
  if (value.usage !== undefined && !isOpenAiUsage(value.usage)) return false;
  return value.model === undefined || typeof value.model === "string";
}

function isOpenAiStreamChoice(value: unknown): value is OpenAiStreamChoice {
  if (!isRecord(value)) return false;
  const hasDelta = "delta" in value;
  const hasFinishReason = "finish_reason" in value;
  if (!hasDelta && !hasFinishReason) return false;
  if (hasDelta && !isOpenAiStreamDelta(value.delta)) return false;
  return (
    !hasFinishReason || value.finish_reason === null || typeof value.finish_reason === "string"
  );
}

function isOpenAiStreamDelta(value: unknown): value is OpenAiStreamChoice["delta"] {
  if (!isRecord(value)) return false;
  // Real reasoning-model providers (deepseek, etc.) emit {role:"assistant",
  // content:null, reasoning_content:"..."} while thinking, then later
  // {content:"answer", reasoning_content:null}. Treat null the same as
  // undefined so we don't reject these legitimate chunks as non-chat payloads.
  return nullableOptionalString(value.content) && nullableOptionalString(value.reasoning_content);
}

function isOpenAiUsage(value: unknown): value is OpenAiUsage {
  if (!isRecord(value)) return false;
  if (!optionalNumber(value.prompt_tokens)) return false;
  if (!optionalNumber(value.completion_tokens)) return false;
  if (!optionalNumber(value.total_tokens)) return false;
  if (
    value.prompt_tokens_details !== undefined &&
    !isOpenAiUsageDetails(value.prompt_tokens_details)
  ) {
    return false;
  }
  return true;
}

function isOpenAiUsageDetails(
  value: unknown,
): value is NonNullable<OpenAiUsage["prompt_tokens_details"]> {
  if (!isRecord(value)) return false;
  return (
    optionalNumber(value.cached_tokens) &&
    optionalNumber(value.cache_read_input_tokens) &&
    optionalNumber(value.cache_creation_input_tokens)
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstFinite(...values: (number | undefined)[]): number | undefined {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function extractUsageMetrics(usage: OpenAiUsage | undefined): UsageMetrics | undefined {
  if (!usage) return undefined;
  const tokensIn = finiteNumber(usage.prompt_tokens);
  const tokensOut = finiteNumber(usage.completion_tokens);
  const details = usage.prompt_tokens_details;
  const tokensCacheRead = firstFinite(details?.cache_read_input_tokens, details?.cached_tokens);
  const tokensCacheWrite = finiteNumber(details?.cache_creation_input_tokens);
  const tokensInput =
    tokensIn === undefined ? undefined : Math.max(0, tokensIn - (tokensCacheRead ?? 0));
  const total = finiteNumber(usage.total_tokens);
  const used =
    total ??
    (tokensIn !== undefined || tokensOut !== undefined
      ? (tokensIn ?? 0) + (tokensOut ?? 0)
      : undefined);
  return {
    tokensIn,
    tokensOut,
    tokensInput,
    tokensCacheRead: tokensCacheRead ?? 0,
    tokensCacheWrite: tokensCacheWrite ?? 0,
    used,
  };
}

function metaFromMetrics(metrics: UsageMetrics | undefined): NonNullable<DispatchOutput["meta"]> {
  return {
    ...(metrics?.tokensIn !== undefined ? { tokens_in: metrics.tokensIn } : {}),
    ...(metrics?.tokensOut !== undefined ? { tokens_out: metrics.tokensOut } : {}),
    ...(metrics?.tokensInput !== undefined ? { tokens_input: metrics.tokensInput } : {}),
    ...(metrics?.tokensCacheRead !== undefined
      ? { tokens_cache_read: metrics.tokensCacheRead }
      : {}),
    ...(metrics?.tokensCacheWrite !== undefined
      ? { tokens_cache_write: metrics.tokensCacheWrite }
      : {}),
  };
}
