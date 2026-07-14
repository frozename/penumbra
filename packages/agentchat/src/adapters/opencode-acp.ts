import type { DispatchEventInput } from "@penumbra/core";

import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import type { AcpServerHandle, StartAcpServerOptions } from "./acp-server.js";
import type { AcpCreateSessionRequest, AcpEvent, McpServer, McpServerStdio } from "./acp-types.js";

import { AcpClient, type AcpClientOptions } from "./acp-client.js";
import { startAcpServer } from "./acp-server.js";
import { createDispatchAbortSignal, type DispatchAbortHandle } from "./dispatch-abort.js";
import { prepareOpencodeMcpConfigDir } from "./opencode-mcp-config.js";

// Adapter lifecycle events for opencode-acp. Without these, the dispatch
// reliability classifier sees no `http.*` / `acp.*` / `proc.*` events and
// flags every successful dispatch as `missing_adapter_lifecycle`. Using
// `http.*` because opencode-acp is HTTP/SSE, not stdio JSON-RPC.
function emitLifecycle(
  input: DispatchInput,
  kind: DispatchEventInput["kind"],
  meta?: Record<string, unknown>,
): void {
  if (!input.eventContext || !input.onEvent) return;
  input.onEvent({
    handoff_id: input.eventContext.handoffId,
    worker_id: input.eventContext.workerId,
    source: "worker",
    kind,
    ts: new Date().toISOString(),
    meta,
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const LONG_LIVED_SELF_TOOL_NAMES = [
  "long_lived_self_state_get",
  "long_lived_self_state_set",
  "long_lived_self_pending_actions",
] as const;
const PENUMBRA_MCP_INJECTED_ENV_KEYS = new Set([
  "PENUMBRA_HANDOFF_ID",
  "PENUMBRA_MCP_ORIGIN",
  "PENUMBRA_LONG_LIVED_AGENT_ID",
  "PENUMBRA_LONG_LIVED_TICK_ID",
  "PENUMBRA_MCP_TOOL_ALLOWLIST",
]);
const PENUMBRA_MCP_ORIGIN_FLEET_WORKER = "fleet-worker";
const MCP_PATH_RE = /penumbra-mcp(?:\.[jt]s)?(?:$|[\s/])/;

function isPenumbraMcp(server: McpServer): server is McpServerStdio {
  if ("type" in server) return false;
  const haystack = [server.name, server.command, ...server.args].join(" ");
  return MCP_PATH_RE.test(haystack);
}

function buildLongLivedMcpEnv(input: DispatchInput): { name: string; value: string }[] {
  const session = input.long_lived_session;
  if (session?.dispatch_kind !== "long_lived_tick") return [];

  const allowlist = new Set(
    (session.mcp_tool_allowlist ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
  );
  for (const toolName of LONG_LIVED_SELF_TOOL_NAMES) {
    allowlist.add(toolName);
  }

  const envEntries: { name: string; value: string }[] = [
    { name: "PENUMBRA_MCP_TOOL_ALLOWLIST", value: [...allowlist].join(",") },
  ];
  if (session.agent_id && session.agent_id.length > 0) {
    envEntries.push({ name: "PENUMBRA_LONG_LIVED_AGENT_ID", value: session.agent_id });
  }
  if (session.tick_id && session.tick_id.length > 0) {
    envEntries.push({ name: "PENUMBRA_LONG_LIVED_TICK_ID", value: session.tick_id });
  }
  return envEntries;
}

function injectPenumbraMcpEnv(servers: McpServer[], input: DispatchInput): McpServer[] {
  const longLivedEnv = buildLongLivedMcpEnv(input);
  const shouldInjectDispatchEnv = Boolean(input.handoff_id) || longLivedEnv.length > 0;
  if (!shouldInjectDispatchEnv) return servers;

  return servers.map((server) => {
    if (!isPenumbraMcp(server)) return server;
    const keptEnv = server.env.filter((entry) => !PENUMBRA_MCP_INJECTED_ENV_KEYS.has(entry.name));
    return {
      ...server,
      env: [
        ...keptEnv,
        ...(input.handoff_id ? [{ name: "PENUMBRA_HANDOFF_ID", value: input.handoff_id }] : []),
        { name: "PENUMBRA_MCP_ORIGIN", value: PENUMBRA_MCP_ORIGIN_FLEET_WORKER },
        ...longLivedEnv,
      ],
    };
  });
}

export interface OpencodeAcpOptions {
  model: string;
  cwd?: string;
  opencodeBinary?: string;
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
  mcpServers?: McpServer[];
}

type AcpClientLike = Pick<AcpClient, "openSession" | "sendMessage">;

interface OpencodeAcpDeps {
  startServer: (opts: StartAcpServerOptions) => Promise<AcpServerHandle>;
  createClient: (opts: AcpClientOptions) => AcpClientLike;
  prepareMcpConfig?: (
    servers: McpServer[],
  ) => Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }>;
}

interface OpencodeWireEvent {
  type?: unknown;
  properties?: OpencodeWireEventProps;
}

interface OpencodeWireEventProps {
  part?: { id?: unknown; type?: unknown };
  field?: unknown;
  partID?: unknown;
  delta?: unknown;
  error?: { data?: { message?: unknown }; name?: unknown };
}

function asWireEvent(evt: unknown): OpencodeWireEvent {
  if (evt === null || typeof evt !== "object") return {};
  return evt;
}

function readPartUpdate(props: OpencodeWireEventProps | undefined): {
  id: string;
  type: string;
} | null {
  const partId = props?.part?.id;
  const partType = props?.part?.type;
  if (typeof partId === "string" && typeof partType === "string") {
    return { id: partId, type: partType };
  }
  return null;
}

function readPartDelta(
  props: OpencodeWireEventProps | undefined,
  partTypeById: Map<string, string>,
): string | null {
  if (props?.field !== "text") return null;
  const partId = props.partID;
  const partType = typeof partId === "string" ? (partTypeById.get(partId) ?? "text") : "text";
  if (partType !== "text") return null;
  const delta = typeof props.delta === "string" ? props.delta : "";
  return delta || null;
}

function readSessionErrorMessage(props: OpencodeWireEventProps | undefined): string {
  const fromData = props?.error?.data?.message;
  if (typeof fromData === "string") return fromData;
  const fromName = props?.error?.name;
  if (typeof fromName === "string") return fromName;
  return "unknown";
}

export class OpencodeAcpAdapter implements Adapter {
  readonly kind = "opencode-acp";

  constructor(
    private readonly opts: OpencodeAcpOptions,
    private readonly deps: OpencodeAcpDeps = {
      startServer: startAcpServer,
      createClient: (clientOpts): AcpClient => new AcpClient(clientOpts),
    },
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    let result: DispatchOutput | null = null;

    for await (const event of this.dispatchStream(input)) {
      if (event.type === "done") {
        result = event.result;
      }
    }

    if (!result) {
      throw new Error("opencode-acp: stream ended without a final result");
    }

    return result;
  }

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const cwd = this.opts.cwd ?? process.cwd();
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const requestAbort = createDispatchAbortSignal(
      input.signal,
      requestTimeoutMs,
      (timeout) => new Error(`opencode-acp request timed out after ${timeout.toString()}ms`),
    );
    const lifecycle: { server: AcpServerHandle | null; xdgCleanup: (() => Promise<void>) | null } =
      {
        server: null,
        xdgCleanup: null,
      };
    let extraEnv: Record<string, string> | undefined;

    const mcpServersWithEnv = injectPenumbraMcpEnv(this.opts.mcpServers ?? [], input);
    if (mcpServersWithEnv.length > 0) {
      const prepare = this.deps.prepareMcpConfig ?? prepareOpencodeMcpConfigDir;
      const { xdgConfigHome, cleanup } = await prepare(mcpServersWithEnv);
      extraEnv = { XDG_CONFIG_HOME: xdgConfigHome };
      lifecycle.xdgCleanup = cleanup;
    }

    try {
      yield* this.runSession(input, cwd, extraEnv, requestAbort, lifecycle);
    } catch (err) {
      if (
        requestAbort.timeoutError &&
        requestAbort.signal.aborted &&
        err instanceof Error &&
        err.name === "AbortError"
      ) {
        throw requestAbort.timeoutError;
      }
      throw err;
    } finally {
      requestAbort.cleanup();
      if (lifecycle.server) {
        await lifecycle.server.kill().catch(() => {
          /* ignore kill errors during teardown */
        });
      }
      if (lifecycle.xdgCleanup) {
        // Guard cleanup so a rmdir/permission failure here does not mask the
        // original dispatch error (which would otherwise be replaced by the
        // cleanup rejection at the top of the awaited finally block).
        await lifecycle.xdgCleanup().catch((cleanupErr: unknown) => {
          console.warn(
            `opencode-acp: xdg cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        });
      }
    }
  }

  private async *runSession(
    input: DispatchInput,
    cwd: string,
    extraEnv: Record<string, string> | undefined,
    requestAbort: DispatchAbortHandle,
    lifecycle: { server: AcpServerHandle | null; xdgCleanup: (() => Promise<void>) | null },
  ): AsyncIterable<DispatchEvent> {
    lifecycle.server = await this.deps.startServer({
      cwd,
      pure: true,
      signal: requestAbort.signal,
      opencodeBinary: this.opts.opencodeBinary ?? "opencode",
      bootTimeoutMs: this.opts.bootTimeoutMs,
      ...(extraEnv ? { env: extraEnv } : {}),
    });
    emitLifecycle(input, "http.server.start", {
      adapter: this.kind,
      binary: this.opts.opencodeBinary ?? "opencode",
      base_url: lifecycle.server.baseUrl,
    });

    const client = this.deps.createClient({
      baseUrl: lifecycle.server.baseUrl,
      signal: requestAbort.signal,
    });
    const sessionReq: AcpCreateSessionRequest = { cwd };
    const { sessionId, workspaceId } = await client.openSession(sessionReq);
    emitLifecycle(input, "http.session.start", {
      adapter: this.kind,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    yield* this.consumeMessageStream(input, client, sessionId, workspaceId, cwd);
  }

  private async *consumeMessageStream(
    input: DispatchInput,
    client: AcpClientLike,
    sessionId: string,
    workspaceId: string | undefined,
    cwd: string,
  ): AsyncIterable<DispatchEvent> {
    // OpenCode emits SSE events as { type, properties: {...} }. The "text"
    // we want is delivered via message.part.delta with properties.field === 'text'
    // — but the model also streams reasoning content as a separate part of type
    // 'reasoning'. We track partID → part type from message.part.updated events
    // and only accumulate deltas for parts whose type is 'text'.
    // Stream ends on session.idle (turn complete) or session.error.
    const partTypeById = new Map<string, string>();
    let text = "";
    const messageStream = client.sendMessage(sessionId, input.prompt, {
      model: this.opts.model,
      tools: [],
      directory: cwd,
      workspace: workspaceId,
    });
    streamLoop: for await (const evtRaw of messageStream) {
      const evt = asWireEvent(evtRaw);
      const props = evt.properties;
      switch (evt.type) {
        case "message.part.updated": {
          const update = readPartUpdate(props);
          if (update) partTypeById.set(update.id, update.type);
          break;
        }
        case "message.part.delta": {
          const delta = readPartDelta(props, partTypeById);
          if (!delta) break;
          text += delta;
          yield { type: "delta", text: delta };
          break;
        }
        case "session.error": {
          throw new Error(`opencode-acp: session.error — ${readSessionErrorMessage(props)}`);
        }
        case "session.idle":
          // Turn finished cleanly. Stop consuming the stream.
          // usage updates are not emitted on this OpenCode ACP SSE wire; cost capture falls back to opencode-db-reader.
          emitLifecycle(input, "http.session.end", {
            adapter: this.kind,
            session_id: sessionId,
            stop_reason: "idle",
          });
          break streamLoop;
        default:
          // Other events (server.connected, session.status, session.diff,
          // server.heartbeat, etc.) are ignored.
          break;
      }
    }

    yield { type: "done", result: { text } };
  }
}

export type { AcpEvent };
