import { isMcpInvocationLogEnabled } from '@penumbra/config';
import type { InvocationRow } from './invocation-sink.js';
import { getSink } from './invocation-sink-registry.js';
import { resolveToolOrigin } from './tool-origin.js';

interface WrapHandlerOptions {
  enabled?: boolean;
}

export type ToolHandler = (args: unknown, extra: unknown) => Promise<unknown>;

/** Cap for caller-supplied origin string so a malicious header can't inflate JSONL rows. */
const ORIGIN_MAX_CHARS = 128;
/** Cap on the constructor/name string for the same reason. */
const ERROR_KIND_MAX_CHARS = 64;
/**
 * Above this serialized length we record `-1` instead of the true byte count.
 * Prevents a tool returning a multi-MB result from inflating every JSONL row
 * past the size that downstream consumers (summarizer, dashboards) expect.
 * The synchronous JSON.stringify still runs — bounding its actual cost is a
 * Phase 5+ follow-up; this only bounds the recorded value.
 */
const MAX_MEASURED_BYTES = 1_048_576;

let warnedAboutMissingSink = false;

function safeStringifyByteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return -1;
    const byteLength = Buffer.byteLength(encoded, 'utf8');
    if (byteLength > MAX_MEASURED_BYTES) return -1;
    return byteLength;
  } catch {
    return -1;
  }
}

function errorClassName(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  // Prefer explicit error.name when the user set one on the class; otherwise
  // fall back to the constructor name (which survives undefined .name but
  // gets mangled to a single letter under identifier minification).
  const explicit = error.name && error.name !== 'Error' ? error.name : undefined;
  const ctorName = typeof error.constructor?.name === 'string' ? error.constructor.name : undefined;
  const chosen = explicit ?? ctorName ?? 'Error';
  return chosen.slice(0, ERROR_KIND_MAX_CHARS);
}

/**
 * MCP tool handlers commonly return `{ content, isError: true }` to surface a
 * failure without throwing. Treat that envelope shape as ok:false so federated
 * proxies and native error-envelope tools both produce accurate telemetry.
 */
function isMcpErrorEnvelope(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && (result as { isError?: unknown }).isError === true;
}

function safeWrite(row: InvocationRow): void {
  try {
    getSink().write(row);
  } catch (err) {
    // Sink unavailable (not initialized — Phase 4 wires this) or write threw.
    // Telemetry must never break tool execution. Emit a one-shot warning so
    // an operational miswire (flag on, sink not initialized) is observable.
    if (!warnedAboutMissingSink) {
      warnedAboutMissingSink = true;
      console.error('[mcp:instrumentation] sink write failed; further failures suppressed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Wraps a tool handler with per-invocation JSONL telemetry. `enabled` is
 * read once at wrap time (typically at server startup); toggling
 * `PENUMBRA_MCP_INVOCATION_LOG_ENABLED` at runtime has no effect until the
 * stdio child restarts.
 */
export function instrumentHandler(
  name: string,
  handler: ToolHandler,
  opts: WrapHandlerOptions = {},
): ToolHandler {
  const enabled = opts.enabled ?? isMcpInvocationLogEnabled();
  if (!enabled) return handler;

  return async function wrappedHandler(args: unknown, extra: unknown): Promise<unknown> {
    const startedWall = new Date().toISOString();
    const startedAt = performance.now();
    const origin = (resolveToolOrigin(extra) ?? 'unknown').slice(0, ORIGIN_MAX_CHARS);
    const argsBytes = safeStringifyByteLength(args);

    try {
      const result = await handler(args, extra);
      const durationMs = Math.round(performance.now() - startedAt);
      const isErrorEnvelope = isMcpErrorEnvelope(result);
      safeWrite({
        ts: startedWall,
        tool: name,
        origin,
        args_bytes: argsBytes,
        result_bytes: safeStringifyByteLength(result),
        duration_ms: durationMs,
        ok: !isErrorEnvelope,
        error_kind: isErrorEnvelope ? 'mcp_error_envelope' : null,
      });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      safeWrite({
        ts: startedWall,
        tool: name,
        origin,
        args_bytes: argsBytes,
        result_bytes: -1,
        duration_ms: durationMs,
        ok: false,
        error_kind: errorClassName(error),
      });
      throw error;
    }
  };
}

/** Test-only reset so the one-shot warning fires fresh in unrelated tests. */
export function _resetWarnedForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetWarnedForTest is test-only');
  }
  warnedAboutMissingSink = false;
}
