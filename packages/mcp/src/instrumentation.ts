import { isMcpInvocationLogEnabled } from '@penumbra/config';
import type { InvocationRow } from './invocation-sink.js';
import { getSink } from './invocation-sink-registry.js';
import { resolveToolOrigin } from './tool-origin.js';

interface WrapHandlerOptions {
  enabled?: boolean;
}

export type AnyHandler = (args: unknown, extra: unknown) => Promise<unknown>;

function safeStringifyLen(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded.length : -1;
  } catch {
    return -1;
  }
}

function errorKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown';
  }

  const name = error.constructor?.name;
  if (typeof name !== 'string' || name.length === 0) {
    return 'Error';
  }

  return name.slice(0, 64);
}

function tryWrite(row: InvocationRow): void {
  try {
    getSink().write(row);
  } catch {
    // Swallow sink failures so telemetry never breaks tool execution.
  }
}

export function wrapHandler(
  name: string,
  handler: AnyHandler,
  opts: WrapHandlerOptions = {},
): AnyHandler {
  const enabled = opts.enabled ?? isMcpInvocationLogEnabled();
  if (!enabled) return handler;

  return async function wrappedHandler(args: unknown, extra: unknown): Promise<unknown> {
    const origin = resolveToolOrigin(extra) ?? 'unknown';
    const args_bytes = safeStringifyLen(args);
    const startedAt = performance.now();

    try {
      const result = await handler(args, extra);
      tryWrite({
        ts: new Date().toISOString(),
        tool: name,
        origin,
        args_bytes,
        result_bytes: safeStringifyLen(result),
        duration_ms: performance.now() - startedAt,
        ok: true,
        error_kind: null,
      });
      return result;
    } catch (error) {
      tryWrite({
        ts: new Date().toISOString(),
        tool: name,
        origin,
        args_bytes,
        result_bytes: 0,
        duration_ms: performance.now() - startedAt,
        ok: false,
        error_kind: errorKind(error),
      });
      throw error;
    }
  };
}
