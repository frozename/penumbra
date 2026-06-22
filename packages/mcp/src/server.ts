import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMcpResponseBudgetTokens, isMcpInvocationLogEnabled } from "@penumbra/config";

import type { DaemonClient } from "./daemon-client.js";

import { registerFederatedTools } from "./federation/client.js";
import { HandleStore } from "./handle-store.js";
import { instrumentHandler } from "./instrumentation.js";
import {
  closeSink,
  initSink,
  resolveDefaultInvocationLogPath,
} from "./invocation-sink-registry.js";
import { setLongLivedRuntimeContextFromEnv } from "./long-lived-context.js";
import {
  READ_HANDLE_DESCRIPTION,
  readHandleHandler,
  ReadHandleInputShape,
} from "./tools/read-handle.js";
import { TOOL_REGISTRY } from "./tools/registry.js";

type ToolBuildContext = {
  handleStore: HandleStore;
};

/**
 * Tools that can spill payloads into the HandleStore independent of the central
 * response budget (workflow_*: explicit `result_handle_id`/`error_handle_id` fields;
 * fs_*: `envelope: true` callers). If `read_handle` is excluded from the allowlist
 * but any of these are allowlisted, the emitted handle_ids will be unresolvable.
 */
const HANDLE_PRODUCING_TOOLS: ReadonlySet<string> = new Set([
  "workflow_wait",
  "workflow_status",
  "fs_glob",
  "fs_grep",
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_exec",
]);

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
  // Parsed ONCE here via the central env registry and passed explicitly to every
  // instrumentHandler call site (registry loop, read_handle, federated tools).
  // instrumentHandler itself never reads the env.
  const envResponseBudgetTokens = getMcpResponseBudgetTokens();
  const readHandleExcluded = allowlist !== null && !allowlist.has("read_handle");
  // Fail closed: if read_handle is not allowlisted, central budget truncation
  // would still wrap large results with handle_ids the client cannot resolve.
  // Disable budgeting entirely in that case so results pass through untruncated.
  const responseBudgetTokens = readHandleExcluded ? null : envResponseBudgetTokens;
  if (readHandleExcluded) {
    warnReadHandleMissing(allowlist, envResponseBudgetTokens);
  }
  // Read the flag ONCE per server build. Pass it explicitly into instrumentHandler so
  // the registration and runtime sides can't disagree if env mutates mid-process.
  const invocationLogEnabled = isMcpInvocationLogEnabled();

  if (invocationLogEnabled) {
    await openInvocationSink();
  }

  try {
    return await assembleServer({
      daemon: opts.daemon,
      allowlist,
      invocationLogEnabled,
      responseBudgetTokens,
    });
  } catch (err) {
    if (invocationLogEnabled) await closeSink();
    throw err;
  }
}

function warnReadHandleMissing(
  allowlist: Set<string> | null,
  envResponseBudgetTokens: number | null,
): void {
  if (allowlist === null) return;
  const handleProducingAllowlisted = [...HANDLE_PRODUCING_TOOLS].filter((tool) =>
    allowlist.has(tool),
  );
  const centralBudgetDisabled = envResponseBudgetTokens !== null;
  if (handleProducingAllowlisted.length === 0 && !centralBudgetDisabled) return;
  console.error(
    JSON.stringify({
      event: "mcp_allowlist_read_handle_missing",
      warning:
        "read_handle is excluded from the tool allowlist; central response budgeting has been disabled, and any allowlisted handle-producing tools (workflow_wait/_status, fs_* envelope outputs) may still emit handle_ids the client cannot resolve.",
      allowlisted_tools: [...allowlist].sort(),
      handle_producing_allowlisted: handleProducingAllowlisted.sort(),
      central_budget_disabled: centralBudgetDisabled,
    }),
  );
}

async function openInvocationSink(): Promise<void> {
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

interface AssembleOptions {
  daemon: DaemonClient;
  allowlist: Set<string> | null;
  invocationLogEnabled: boolean;
  responseBudgetTokens: number | null;
}

async function assembleServer(opts: AssembleOptions): Promise<McpServer> {
  const { daemon, allowlist, invocationLogEnabled, responseBudgetTokens } = opts;
  const server = new McpServer({ name: "penumbra", version: "0.0.0" });
  const handleStore = new HandleStore();
  const serverCtx: ToolBuildContext = { handleStore };
  registerRegistryTools({
    server,
    daemon,
    serverCtx,
    handleStore,
    allowlist,
    invocationLogEnabled,
    responseBudgetTokens,
  });
  if (!allowlist || allowlist.has("read_handle")) {
    registerReadHandleTool({ server, handleStore, invocationLogEnabled, responseBudgetTokens });
  }
  installHandleStoreTeardown(server, handleStore);
  const result = await registerFederatedTools({
    server,
    daemon,
    envAllowlist: allowlist ?? undefined,
    invocationLogEnabled,
    responseBudgetTokens,
    handleStore,
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
}

interface RegistryRegistrationOpts {
  server: McpServer;
  daemon: DaemonClient;
  serverCtx: ToolBuildContext;
  handleStore: HandleStore;
  allowlist: Set<string> | null;
  invocationLogEnabled: boolean;
  responseBudgetTokens: number | null;
}

function registerRegistryTools(opts: RegistryRegistrationOpts): void {
  const { server, daemon, serverCtx, handleStore, allowlist } = opts;
  for (const [rawName, def] of Object.entries(TOOL_REGISTRY)) {
    const name = canonicalToolId(rawName);
    if (!name) continue;
    if (allowlist && !allowlist.has(name)) continue;
    const handler = instrumentHandler(name, def.makeHandler(daemon, serverCtx), {
      enabled: opts.invocationLogEnabled,
      responseBudgetTokens: opts.responseBudgetTokens,
      handleStore,
    });
    server.registerTool(
      name,
      def.descriptor as Parameters<typeof server.registerTool>[1],
      handler as unknown as Parameters<typeof server.registerTool>[2],
    );
  }
}

interface ReadHandleRegistrationOpts {
  server: McpServer;
  handleStore: HandleStore;
  invocationLogEnabled: boolean;
  responseBudgetTokens: number | null;
}

function registerReadHandleTool(opts: ReadHandleRegistrationOpts): void {
  // read_handle is registered OUTSIDE the TOOL_REGISTRY loop on purpose: it
  // needs the HandleStore, not the daemon, so it can't go through
  // def.makeHandler(opts.daemon). Never add "read_handle" to TOOL_REGISTRY — it
  // would register twice. server.test.ts locks the full registered set to
  // [...TOOL_REGISTRY, "read_handle"] to catch that.
  const readHandle = instrumentHandler("read_handle", readHandleHandler(opts.handleStore), {
    enabled: opts.invocationLogEnabled,
    responseBudgetTokens: opts.responseBudgetTokens,
    handleStore: opts.handleStore,
  });
  opts.server.registerTool(
    "read_handle",
    {
      description: READ_HANDLE_DESCRIPTION,
      inputSchema: ReadHandleInputShape,
    } as Parameters<typeof opts.server.registerTool>[1],
    readHandle as unknown as Parameters<typeof opts.server.registerTool>[2],
  );
}

function installHandleStoreTeardown(server: McpServer, handleStore: HandleStore): void {
  let handleStoreClosed = false;
  const closeHandleStore = (): void => {
    if (handleStoreClosed) return;
    handleStoreClosed = true;
    handleStore.close();
  };
  const priorClose = server.close.bind(server);
  // Keep teardown on the public close() surface and avoid coupling to SDK internals.
  (server as unknown as { close: () => Promise<void> }).close = async (): Promise<void> => {
    try {
      await priorClose();
    } finally {
      closeHandleStore();
    }
  };
}
