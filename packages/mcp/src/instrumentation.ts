import { isMcpInvocationLogEnabled } from "@penumbra/config";
import type { InvocationRow } from "./invocation-sink.js";
import { getSink } from "./invocation-sink-registry.js";
import { HandleStore } from "./handle-store.js";
import { estimateTokens, sliceSurrogateSafe, truncateToTokens } from "./responses/budget.js";
import { isEnvelopeResult, makeEnvelopeResult } from "./responses/envelope.js";
import { resolveToolOrigin } from "./tool-origin.js";

interface WrapHandlerOptions {
  enabled?: boolean;
  responseBudgetTokens?: number | null;
  handleStore?: HandleStore;
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

function boundedByteLength(encoded: string): number {
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength > MAX_MEASURED_BYTES) return -1;
  return byteLength;
}

function safeStringifyByteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return -1;
    return boundedByteLength(encoded);
  } catch {
    return -1;
  }
}

function errorClassName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  // Prefer explicit error.name when the user set one on the class; otherwise
  // fall back to the constructor name (which survives undefined .name but
  // gets mangled to a single letter under identifier minification).
  const explicit = error.name && error.name !== "Error" ? error.name : undefined;
  const ctorName = typeof error.constructor?.name === "string" ? error.constructor.name : undefined;
  const chosen = explicit ?? ctorName ?? "Error";
  return chosen.slice(0, ERROR_KIND_MAX_CHARS);
}

/**
 * MCP tool handlers commonly return `{ content, isError: true }` to surface a
 * failure without throwing. Treat that envelope shape as ok:false so federated
 * proxies and native error-envelope tools both produce accurate telemetry.
 */
function isMcpErrorEnvelope(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
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
      console.error("[mcp:instrumentation] sink write failed; further failures suppressed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function buildRecoveryMarker(handleId: string, usedTokens: number, limitTokens: number): string {
  return `\n[truncated: ${usedTokens} tokens > ${limitTokens} token budget — full payload: read_handle ${handleId}]`;
}

function applyBudgetRecoveryMarker(
  text: string,
  handleId: string,
  usedTokens: number,
  limitTokens: number,
): string {
  const marker = buildRecoveryMarker(handleId, usedTokens, limitTokens);
  const markerTokens = estimateTokens(marker);
  const allowedBodyTokens = limitTokens - markerTokens;
  if (allowedBodyTokens <= 0) return marker;
  const allowedBodyChars = allowedBodyTokens * 4;
  const body = sliceSurrogateSafe(text, Math.max(0, allowedBodyChars));
  return `${body}${marker}`;
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
  // The budget comes EXCLUSIVELY from explicitly passed options (parsed once in
  // buildServer) — never from env. Budgeting is also a hard no-op without a
  // HandleStore: truncating with nowhere to spill the full payload would make
  // the result unrecoverable (re-calls would just re-truncate).
  const responseBudgetTokens = opts.responseBudgetTokens ?? null;
  const budget =
    responseBudgetTokens !== null && opts.handleStore !== undefined
      ? { limitTokens: responseBudgetTokens, store: opts.handleStore }
      : null;
  if (!enabled && budget === null) return handler;

  return async function wrappedHandler(args: unknown, extra: unknown): Promise<unknown> {
    const startedWall = new Date().toISOString();
    const startedAt = performance.now();
    const origin = (resolveToolOrigin(extra) ?? "unknown").slice(0, ORIGIN_MAX_CHARS);
    const argsBytes = safeStringifyByteLength(args);

    try {
      const result = await handler(args, extra);
      let wrappedResult = result;
      let budgetSerialized: string | undefined;
      if (
        budget !== null &&
        name !== "read_handle" &&
        !isEnvelopeResult(result) &&
        !isMcpErrorEnvelope(result)
      ) {
        // Serializing an arbitrary tool result can throw (BigInt, circular
        // references, a throwing toJSON). Budgeting must never break tool
        // execution — on failure skip budgeting and pass the result through.
        try {
          budgetSerialized = JSON.stringify(result);
        } catch {
          budgetSerialized = undefined;
        }
        if (budgetSerialized !== undefined) {
          const usedTokens = estimateTokens(budgetSerialized);
          if (usedTokens > budget.limitTokens) {
            const handleId = budget.store.put(budgetSerialized);
            const { text, truncated } = truncateToTokens(budgetSerialized, budget.limitTokens);
            const textWithMarker = truncated
              ? applyBudgetRecoveryMarker(text, handleId, usedTokens, budget.limitTokens)
              : text;
            const envelope = makeEnvelopeResult([{ type: "text", text: textWithMarker }], {
              usedTokens,
              limitTokens: budget.limitTokens,
              truncated,
              resultBytes: Buffer.byteLength(budgetSerialized, "utf8"),
              handleId,
            });
            wrappedResult = envelope;
          }
        }
      }
      const durationMs = Math.round(performance.now() - startedAt);
      if (enabled) {
        const isErrorEnvelope = isMcpErrorEnvelope(wrappedResult);
        // Reuse the budget-check serialization when the result was passed
        // through unwrapped, so logging + budget don't serialize it twice.
        const resultBytes =
          wrappedResult === result && budgetSerialized !== undefined
            ? boundedByteLength(budgetSerialized)
            : safeStringifyByteLength(wrappedResult);
        safeWrite({
          ts: startedWall,
          pid: process.pid,
          tool: name,
          origin,
          args_bytes: argsBytes,
          result_bytes: resultBytes,
          duration_ms: durationMs,
          ok: !isErrorEnvelope,
          error_kind: isErrorEnvelope ? "mcp_error_envelope" : null,
        });
      }
      return wrappedResult;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (enabled) {
        safeWrite({
          ts: startedWall,
          pid: process.pid,
          tool: name,
          origin,
          args_bytes: argsBytes,
          result_bytes: -1,
          duration_ms: durationMs,
          ok: false,
          error_kind: errorClassName(error),
        });
      }
      throw error;
    }
  };
}

/** Test-only reset so the one-shot warning fires fresh in unrelated tests. */
export function _resetWarnedForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_resetWarnedForTest is test-only");
  }
  warnedAboutMissingSink = false;
}
