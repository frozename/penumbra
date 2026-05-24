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
      reason: 'http_error' | 'timeout' | 'invalid_json' | 'schema_violation' | 'empty_response';
      message: string;
      status?: number;
    };

export async function llmInvoke<T extends z.ZodTypeAny>(input: LlmInvokeInput<T>): Promise<LlmInvokeResult<T>> {
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
        message: body || response.statusText,
      };
    }

    const responseBodyText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(responseBodyText);
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_json',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty_response',
        message: 'no response content',
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_json',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const parsedValue = input.schema.safeParse(parsed);
    if (!parsedValue.success) {
      return {
        ok: false,
        reason: 'schema_violation',
        message: JSON.stringify(parsedValue.error.flatten()),
      };
    }

    return {
      ok: true,
      value: parsedValue.data,
      raw: message,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        reason: 'timeout',
        message: error.message,
      };
    }

    return {
      ok: false,
      reason: 'http_error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
