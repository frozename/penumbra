import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isMcpInvocationLogEnabled } from "@penumbra/config";
import type { DaemonClient } from "./daemon-client.js";
import { registerFederatedTools } from "./federation/client.js";
import { instrumentHandler } from "./instrumentation.js";
import {
  closeSink,
  initSink,
  resolveDefaultInvocationLogPath,
} from "./invocation-sink-registry.js";
import { setLongLivedRuntimeContextFromEnv } from "./long-lived-context.js";
import { HandleStore } from "./handle-store.js";
import {
  READ_HANDLE_DESCRIPTION,
  ReadHandleInputShape,
  readHandleHandler,
} from "./tools/read-handle.js";
import { TOOL_REGISTRY } from "./tools/registry.js";

export function canonicalToolId(rawId: string): string | null {
  const trimmed = rawId.trim();
  if (trimmed.length === 0) return null;
  // Strip mcp__penumbra__ wire-form prefix
  if (trimmed.startsWith("mcp__")) {
    const parts = trimmed.split("__");
    if (parts.length !== 3) return null;
    const [, serverName, toolName] = parts;
    if (serverName !== "penumbra") return null;
    if (!toolName || toolName.trim().length === 0) return null;
    return toolName.trim();
  }
  // Strip penumbra: short-form prefix (used in yaml allowlists)
  if (trimmed.startsWith("penumbra:")) {
    return trimmed.slice("penumbra:".length);
  }
  // Pass through any other prefix unchanged (ha:, etc. are non-penumbra tools)
  return trimmed;
}

function parseAllowlist(env: NodeJS.ProcessEnv): Set<string> | null {
  const raw = env.PENUMBRA_MCP_TOOL_ALLOWLIST;
  if (!raw) return null;
  const tokens = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (tokens.length === 0) return null;
  const names = raw
    .split(",")
    .map((name) => canonicalToolId(name))
    .filter((name): name is string => name !== null);
  return new Set(names);
}

export async function buildServer(opts: {
  daemon: DaemonClient;
  shellEnabled?: boolean;
}): Promise<McpServer> {
  setLongLivedRuntimeContextFromEnv(process.env);
  const allowlist = parseAllowlist(process.env);
  // Read the flag ONCE per server build. Pass it explicitly into instrumentHandler so
  // the registration and runtime sides can't disagree if env mutates mid-process.
  const invocationLogEnabled = isMcpInvocationLogEnabled();

  if (invocationLogEnabled) {
    // closeSink before initSink so a second buildServer call in the same process
    // (tests, embedded usage) doesn't trip the "already initialized" guard.
    await closeSink();
    try {
      await initSink(resolveDefaultInvocationLogPath());
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "mcp_invocation_sink_init_failed",
          path: resolveDefaultInvocationLogPath(),
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      throw err;
    }
  }

  try {
    const server = new McpServer({ name: "penumbra", version: "0.0.0" });
    for (const [rawName, def] of Object.entries(TOOL_REGISTRY)) {
      const name = canonicalToolId(rawName);
      if (!name) continue;
      if (allowlist && !allowlist.has(name)) continue;
      const handler = instrumentHandler(name, def.makeHandler(opts.daemon) as any, {
        enabled: invocationLogEnabled,
      });
      server.registerTool(
        name,
        def.descriptor as Parameters<typeof server.registerTool>[1],
        handler as unknown as Parameters<typeof server.registerTool>[2],
      );
    }
    // read_handle is registered OUTSIDE the TOOL_REGISTRY loop on purpose: it
    // needs the HandleStore, not the daemon, so it can't go through
    // def.makeHandler(opts.daemon). Never add "read_handle" to TOOL_REGISTRY — it
    // would register twice (the loop above + this block). server.test.ts locks the
    // full registered set to [...TOOL_REGISTRY, "read_handle"] to catch that.
    // TODO(token-opt S3 / producer phase): no tool calls handleStore.put() yet, so
    // read_handle always returns handle_not_found until producers (search.ts spill,
    // workflow_wait) are wired. When that lands, give the store a caller-owned
    // lifecycle (inject via buildServer opts, or close() it on server teardown) so
    // reentrant buildServer callers don't accumulate live TTL timers.
    const handleStore = new HandleStore();
    if (!allowlist || allowlist.has("read_handle")) {
      const readHandle = instrumentHandler("read_handle", readHandleHandler(handleStore) as any, {
        enabled: invocationLogEnabled,
      });
      server.registerTool(
        "read_handle",
        {
          description: READ_HANDLE_DESCRIPTION,
          inputSchema: ReadHandleInputShape,
        } as Parameters<typeof server.registerTool>[1],
        readHandle as unknown as Parameters<typeof server.registerTool>[2],
      );
    }
    const result = await registerFederatedTools({
      server,
      daemon: opts.daemon,
      envAllowlist: allowlist ?? undefined,
      invocationLogEnabled,
    });
    console.error(
      JSON.stringify({
        event: "federation.registered",
        registered_count: result.registered.length,
        skipped_count: result.skipped.length,
        skipped: result.skipped,
      }),
    );
    return server;
  } catch (err) {
    // Don't leak the open sink fd if anything downstream of initSink throws.
    if (invocationLogEnabled) await closeSink();
    throw err;
  }
}
