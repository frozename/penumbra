import { z } from 'zod';

export interface LlmInvokeInput<T extends z.ZodTypeAny> {
  baseUrl: string;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  schema: T;
  timeoutMs?: number;
  temperature?: number;
}

export type LlmInvokeResult<T extends z.ZodTypeAny> =
  | { ok: true; value: z.infer<T>; raw: string }
  | {
      ok: false;
      reason: 'http_error';
      failureMessage: string;
      status: number;
    }
  | {
      ok: false;
      reason: 'timeout' | 'invalid_json' | 'schema_violation' | 'empty_response';
      failureMessage: string;
    };

export async function llmInvoke<T extends z.ZodTypeAny>(input: LlmInvokeInput<T>): Promise<LlmInvokeResult<T>> {
  const maxResponseBytes = 1024 * 1024;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'AbortError'));
  }, timeoutMs);

  try {
    const response = await globalThis.fetch(`${input.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        reason: 'http_error',
        status: response.status,
        failureMessage: body || response.statusText,
      };
    }

    const responseLengthHeader = response.headers.get('content-length');
    const responseLength = responseLengthHeader ? Number.parseInt(responseLengthHeader, 10) : Number.NaN;
    if (Number.isFinite(responseLength) && responseLength > maxResponseBytes) {
      return {
        ok: false,
        reason: 'http_error',
        status: response.status,
        failureMessage: 'response too large',
      };
    }

    const responseBodyText = await response.text();
    if (responseBodyText.length > maxResponseBytes) {
      return {
        ok: false,
        reason: 'http_error',
        status: response.status,
        failureMessage: 'response too large',
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseBodyText);
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_json',
        failureMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const responseMessage = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof responseMessage !== 'string' || responseMessage.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty_response',
        failureMessage: 'no response content',
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(responseMessage);
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_json',
        failureMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const parsedValue = input.schema.safeParse(parsed);
    if (!parsedValue.success) {
      return {
        ok: false,
        reason: 'schema_violation',
        failureMessage: JSON.stringify(parsedValue.error.flatten()),
      };
    }

    return {
      ok: true,
      value: parsedValue.data,
      raw: responseMessage,
    };
    } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        reason: 'timeout',
        failureMessage: error.message,
      };
    }

    return {
      ok: false,
      reason: 'http_error',
      status: 0,
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
