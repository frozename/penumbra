import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";
import type { HandleStore } from "../handle-store.js";

import { instrumentHandler } from "../instrumentation.js";
import { getLongLivedRuntimeContext } from "../long-lived-context.js";

interface VirtualToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface SkippedTool {
  name: string;
  reason: string;
}

export interface RegisterFederatedToolsResult {
  registered: VirtualToolDef[];
  skipped: SkippedTool[];
  /**
   * Set when the daemon federation-tools fetch failed (network error, non-2xx,
   * daemon mid-restart). Distinguishes a total-fetch failure — which the caller
   * should surface loudly — from a legitimately-empty federation set. Absent on
   * success so existing equality checks against `{ registered: [], skipped: [] }`
   * still match a genuinely-empty response.
   */
  fetch_failed?: true;
}

interface RegisterFederatedToolsOpts {
  server: McpServer;
  // Narrowed to the two methods this function actually calls so tests can
  // build typed mocks without satisfying the full DaemonClient surface.
  daemon: Pick<DaemonClient, "getFederationTools" | "mcpCall">;
  agentId?: string;
  tickId?: string;
  envAllowlist?: Set<string>;
  /**
   * Whether `instrumentHandler` should install invocation telemetry. The caller
   * (`buildServer`) reads `isMcpInvocationLogEnabled()` once and passes the
   * decision in so registration and runtime can't disagree.
   */
  invocationLogEnabled?: boolean;
  /**
   * Central response budget in estimated tokens, parsed once by `buildServer`.
   * Must be passed together with `handleStore` — `instrumentHandler` refuses to
   * budget without a spill target.
   */
  responseBudgetTokens?: number | null;
  /** Spill target for oversized results so federated tools get real `read_handle` recovery. */
  handleStore?: HandleStore;
}

// Passthrough object schema: accepts any keys and preserves them through
// SDK input validation, so tool-call args reach the handler intact. An
// empty raw shape ({}) builds a STRICT empty schema that strips every
// unknown key — the inverse of what we want for a federated forwarder.
const PASSTHROUGH_INPUT_SCHEMA = z.object({}).catchall(z.unknown());
export const MAX_META_BYTES = 2048;
let oversizedDropCount = 0;

function asMetaRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // asMetaRecord validates the TOP-LEVEL prototype only. Nested values may
  // still carry unusual prototypes; safety relies on JSON round-trip when
  // the payload reaches the wire. Consumers that observe `_meta` without
  // re-serialising MUST re-validate nested values.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return value as Record<string, unknown>;
}

interface EnvelopeBlock {
  content: { type: "text"; text: string }[];
  isError?: true;
}

function envelope(body: object, isError = false): EnvelopeBlock {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(body),
      },
    ],
    ...(isError ? { isError: true as const } : {}),
  };
}

export async function registerFederatedTools(
  opts: RegisterFederatedToolsOpts,
): Promise<RegisterFederatedToolsResult> {
  const ctx = getLongLivedRuntimeContext();
  const agentId = opts.agentId ?? ctx.running_agent_id;
  const tickId = opts.tickId ?? ctx.running_tick_id;
  if (!agentId || !tickId) return { registered: [], skipped: [] };

  let federationResponse: { tools: VirtualToolDef[] };
  try {
    federationResponse = await opts.daemon.getFederationTools(agentId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[federation] failed to fetch federation tools:", message);
    // fetch_failed: distinguishes a total-fetch failure from a legitimately-empty
    // federation set — must NOT rethrow (would abort MCP boot including core tools).
    return { registered: [], skipped: [], fetch_failed: true };
  }

  const allow = opts.envAllowlist;
  const tools = allow
    ? federationResponse.tools.filter((tool) => allow.has(tool.name))
    : federationResponse.tools;

  const registered: VirtualToolDef[] = [];
  const skipped: SkippedTool[] = [];
  for (const tool of tools) {
    try {
      const proxyHandler = async (args: unknown, extra: unknown): Promise<unknown> => {
        try {
          const wireToolName = tool.name.replace(/^([^.:]+)\./, "$1:");
          let _meta = asMetaRecord((extra as { _meta?: unknown } | null | undefined)?._meta);
          if (_meta) {
            let metaBytes = 0;
            try {
              metaBytes = Buffer.byteLength(JSON.stringify(_meta), "utf8");
            } catch {
              metaBytes = MAX_META_BYTES + 1;
            }
            if (metaBytes > MAX_META_BYTES) {
              oversizedDropCount += 1;
              console.error("[federation] dropped oversized _meta", {
                bytes: metaBytes,
                total_drops: oversizedDropCount,
              });
              _meta = undefined;
            }
          }
          const result = await opts.daemon.mcpCall({
            agent_id: agentId,
            tick_id: tickId,
            tool: wireToolName,
            args: args ?? {},
            ...(_meta ? { _meta } : {}),
          });
          const body = result as {
            action_status?: string;
            result?: unknown;
            pending_action_id?: string;
            error?: string;
            details?: unknown;
            message?: string;
          };
          if (body.action_status === "executed") {
            return body.result;
          }
          if (body.action_status === "queued") {
            return envelope({
              action_status: "queued",
              pending_action_id: body.pending_action_id,
              message: body.message,
            });
          }
          return envelope(
            {
              action_status: body.action_status ?? "rejected",
              error: body.error ?? "unknown_error",
              details: body.details,
            },
            true,
          );
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          return envelope(
            {
              action_status: "rejected",
              error: "mcp_unavailable",
              details: detail,
            },
            true,
          );
        }
      };
      const instrumented = instrumentHandler(tool.name, proxyHandler, {
        enabled: opts.invocationLogEnabled,
        responseBudgetTokens: opts.responseBudgetTokens,
        handleStore: opts.handleStore,
      });
      opts.server.registerTool(
        tool.name,
        {
          description: tool.description ?? `(federated via daemon) ${tool.name}`,
          inputSchema: PASSTHROUGH_INPUT_SCHEMA,
        } as Parameters<typeof opts.server.registerTool>[1],
        instrumented as Parameters<typeof opts.server.registerTool>[2],
      );
      registered.push(tool);
    } catch (err: unknown) {
      // One bad federated tool must not crash the whole MCP server boot.
      // Surface the skip both in logs and in the return shape so callers
      // can report degraded-federation startup state.
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ name: tool.name, reason });
      console.warn(`[federation] failed to register tool name=${tool.name} reason=${reason}`);
    }
  }

  return { registered, skipped };
}
