import { z } from "zod";

import {
  attemptLlmCandidates,
  buildChatCompletionsUrl,
  describeLlmCandidate,
  type LlmAuthSource,
  type LlmCandidate,
  type LlmPurpose,
  type LlmRoutingBias,
  type LlmServingCandidate,
  type ResolveKeychainSecret,
  resolveLlmAuthorization,
  resolveLlmCandidates,
  resolveLlmProvider,
  type ResolvedLlmCandidate,
} from "../../../core/src/services/llm-candidates.js";

export interface LlmInvokeInput<T extends z.ZodType> {
  baseUrl: string;
  model: string;
  provider?: string;
  auth?: LlmAuthSource;
  candidateName?: string;
  fallbackCandidates?: LlmCandidate[];
  activeBiases?: LlmRoutingBias[];
  purpose?: LlmPurpose;
  now?: Date;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  schema: T;
  timeoutMs?: number;
  temperature?: number;
  fetchFn?: typeof fetch;
  resolveKeychain?: ResolveKeychainSecret;
}

type LlmInvokeFailure =
  | {
      ok: false;
      reason: "http_error";
      failureMessage: string;
      status: number;
      candidate?: LlmServingCandidate;
    }
  | {
      ok: false;
      reason: "timeout" | "invalid_json" | "schema_violation" | "empty_response";
      failureMessage: string;
      candidate?: LlmServingCandidate;
    };

type SingleCandidateResult<T extends z.ZodType> =
  | { ok: true; value: z.infer<T>; raw: string }
  | LlmInvokeFailure;

export type LlmInvokeResult<T extends z.ZodType> =
  | { ok: true; value: z.infer<T>; raw: string; candidate: LlmServingCandidate }
  | LlmInvokeFailure;

function httpError<T extends z.ZodType>(
  status: number,
  failureMessage: string,
): SingleCandidateResult<T> {
  return { ok: false, reason: "http_error", status, failureMessage };
}

function parseContent<T extends z.ZodType>(
  responseMessage: string,
  schema: T,
): SingleCandidateResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseMessage) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_json",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
  const parsedValue = schema.safeParse(parsed);
  if (!parsedValue.success) {
    return {
      ok: false,
      reason: "schema_violation",
      failureMessage: JSON.stringify(z.treeifyError(parsedValue.error)),
    };
  }
  return { ok: true, value: parsedValue.data, raw: responseMessage };
}

async function parseHttpResponse<T extends z.ZodType>(
  response: Response,
  maxResponseBytes: number,
  schema: T,
): Promise<SingleCandidateResult<T>> {
  const responseLengthHeader = response.headers.get("content-length");
  const responseLength = responseLengthHeader
    ? Number.parseInt(responseLengthHeader, 10)
    : Number.NaN;
  if (Number.isFinite(responseLength) && responseLength > maxResponseBytes) {
    return httpError(response.status, "response too large");
  }

  const responseBodyText = await response.text();
  if (responseBodyText.length > maxResponseBytes) {
    return httpError(response.status, "response too large");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseBodyText) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_json",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const responseMessage = (payload as { choices?: { message?: { content?: unknown } }[] })
    .choices?.[0]?.message?.content;
  if (typeof responseMessage !== "string" || responseMessage.trim().length === 0) {
    return { ok: false, reason: "empty_response", failureMessage: "no response content" };
  }

  return parseContent(responseMessage, schema);
}

export async function llmInvoke<T extends z.ZodType>(
  input: LlmInvokeInput<T>,
): Promise<LlmInvokeResult<T>> {
  const maxResponseBytes = 1024 * 1024;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const candidates = resolveLlmCandidates({
    purpose: input.purpose ?? "generation",
    activeBiases: input.activeBiases,
    now: input.now,
    candidates: [
      {
        name: input.candidateName ?? input.model,
        baseUrl: input.baseUrl,
        model: input.model,
        provider: resolveLlmProvider(input.baseUrl, input.provider),
        auth: input.auth ?? { source: "none" },
      },
      ...(input.fallbackCandidates ?? []),
    ],
  });
  const attempted = await attemptLlmCandidates<
    { value: z.infer<T>; raw: string },
    LlmInvokeFailure
  >(candidates, async (candidate) => {
    const result = await invokeCandidate(input, candidate, timeoutMs, maxResponseBytes);
    return result.ok
      ? { ok: true as const, value: { value: result.value, raw: result.raw } }
      : { ok: false as const, error: result };
  });
  if (attempted.ok) {
    return {
      ok: true,
      value: attempted.value.value,
      raw: attempted.value.raw,
      candidate: describeLlmCandidate(attempted.candidate),
    };
  }
  const finalFailure = attempted.failures.at(-1);
  if (!finalFailure) {
    throw new Error("no LLM candidate attempt was made");
  }
  if (candidates.length === 1) return finalFailure.error;
  return { ...finalFailure.error, candidate: describeLlmCandidate(finalFailure.candidate) };
}

async function invokeCandidate<T extends z.ZodType>(
  input: LlmInvokeInput<T>,
  candidate: ResolvedLlmCandidate,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<SingleCandidateResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "AbortError"));
  }, timeoutMs);

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = resolveLlmAuthorization(candidate, input.resolveKeychain);
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await (input.fetchFn ?? globalThis.fetch)(
      buildChatCompletionsUrl(candidate.baseUrl),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: candidate.model,
          messages: input.messages,
          temperature: input.temperature ?? 0,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return httpError(response.status, body || response.statusText);
    }

    return await parseHttpResponse(response, maxResponseBytes, input.schema);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "timeout", failureMessage: error.message };
    }
    return httpError(0, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}
