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
const DEFAULT_OPEN_SESSION_TIMEOUT_MS = 60_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
// Rolling per-gap inactivity budget for the SSE stream watchdog. The sibling
// stdio-acp adapter uses its DEFAULT_REQUEST_TIMEOUT_MS (1_200_000 / 20min) as
// the rolling prompt timeout — its comment notes 5min was too tight for stdio
// JSON-RPC turns where a long LLM reply or multi-minute test run emits no
// session/update for minutes. opencode-acp streams over HTTP/SSE, where events
// flow more continuously than stdio request/response; a 5min gap in SSE
// activity is a stronger signal of a wedged turn. 300s is also meaningfully
// shorter than the 600s outer total budget, so the watchdog can actually fire
// before requestAbort instead of being inert (Defect 1). Per-seat
// `inactivityTimeoutMs` overrides this.
const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000;
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
  inactivityTimeoutMs?: number;
  openSessionTimeoutMs?: number;
  firstEventTimeoutMs?: number;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateReason(reason: string): string {
  return reason.length > 300 ? reason.slice(0, 300) : reason;
}

function emitDispatchError(
  input: DispatchInput,
  stage: "server_boot" | "session_open" | "stream",
  err: unknown,
): void {
  emitLifecycle(input, "http.dispatch.error", {
    stage,
    reason: truncateReason(errorMessage(err)),
  });
}

interface PhaseAbortHandle {
  signal: AbortSignal;
  clearTimer: () => void;
  cleanup: () => void;
}

function createPhaseAbortSignal(
  parent: AbortSignal,
  timeoutMs: number,
  makeTimeoutError: (elapsedMs: number) => Error,
): PhaseAbortHandle {
  if (timeoutMs <= 0) {
    return {
      signal: parent,
      clearTimer(): void {
        /* no timer */
      },
      cleanup(): void {
        /* no resources */
      },
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortWith = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const onParentAbort = (): void => {
    abortWith(parent.reason);
  };

  if (parent.aborted) {
    onParentAbort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  timer = setTimeout(() => {
    const err = makeTimeoutError(Date.now() - started);
    err.name = "AbortError";
    abortWith(err);
  }, timeoutMs);

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    signal: controller.signal,
    clearTimer,
    cleanup(): void {
      clearTimer();
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    throw reason instanceof Error ? reason : new Error("opencode-acp: operation aborted");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("opencode-acp: operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

interface RollingInactivityHandle {
  arm(timeoutMs: number, makeError: (timeoutMs: number) => Error): void;
  cleanup(): void;
}

// The watchdog aborts a per-turn AbortController instead of rejecting a
// long-lived promise. Rejecting a stored promise only settled a race; it
// left iterator.next(), the SSE reader.read(), and the POST /message fetch
// pending until the server process was killed. The abort travels through
// the composite client signal and tears the connection down. A fresh
// controller per turn also removes the one-shot hazard: a stored rejection
// permanently poisoned the promise (arm re-set the timer but could not
// un-reject it), while an abort can only ever fire the turn it expired in.
function createRollingInactivityHandle(controller: AbortController): RollingInactivityHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    arm(timeoutMs, makeError): void {
      disarm();
      if (timeoutMs <= 0 || controller.signal.aborted) return;
      timer = setTimeout(() => {
        controller.abort(makeError(timeoutMs));
      }, timeoutMs);
    },
    cleanup: disarm,
  };
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
    try {
      lifecycle.server = await this.deps.startServer({
        cwd,
        pure: true,
        signal: requestAbort.signal,
        opencodeBinary: this.opts.opencodeBinary ?? "opencode",
        bootTimeoutMs: this.opts.bootTimeoutMs,
        ...(extraEnv ? { env: extraEnv } : {}),
      });
    } catch (err) {
      emitDispatchError(input, "server_boot", err);
      throw err;
    }
    emitLifecycle(input, "http.server.start", {
      adapter: this.kind,
      binary: this.opts.opencodeBinary ?? "opencode",
      base_url: lifecycle.server.baseUrl,
    });

    const sessionReq: AcpCreateSessionRequest = { cwd };
    let sessionId: string;
    let workspaceId: string | undefined;
    const openSessionTimeoutMs = this.opts.openSessionTimeoutMs ?? DEFAULT_OPEN_SESSION_TIMEOUT_MS;
    const openAbort = createPhaseAbortSignal(
      requestAbort.signal,
      openSessionTimeoutMs,
      (elapsedMs) => {
        emitLifecycle(input, "http.session.open_timeout", {
          adapter: this.kind,
          elapsed_ms: elapsedMs,
        });
        return new Error(
          `opencode-acp: session open timed out after ${String(openSessionTimeoutMs)}ms`,
        );
      },
    );
    try {
      const client = this.deps.createClient({
        baseUrl: lifecycle.server.baseUrl,
        signal: openAbort.signal,
      });
      const opened = await awaitWithSignal(client.openSession(sessionReq), openAbort.signal);
      sessionId = opened.sessionId;
      workspaceId = opened.workspaceId;
    } catch (err) {
      emitDispatchError(input, "session_open", err);
      throw err;
    } finally {
      openAbort.cleanup();
    }
    emitLifecycle(input, "http.session.start", {
      adapter: this.kind,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    try {
      yield* this.consumeMessageStream(
        input,
        lifecycle.server.baseUrl,
        requestAbort,
        sessionId,
        workspaceId,
        cwd,
      );
    } catch (err) {
      emitDispatchError(input, "stream", err);
      throw err;
    }
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the ACP stream state machine while grandfathering its pre-existing complexity.
  private async *consumeMessageStream(
    input: DispatchInput,
    baseUrl: string,
    requestAbort: DispatchAbortHandle,
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
    let sawEvent = false;
    let sawIdle = false;
    let lastEventType = "none";
    const inactivityTimeoutMs = this.opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    const firstEventTimeoutMs = this.opts.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
    const streamAbort = createPhaseAbortSignal(
      requestAbort.signal,
      firstEventTimeoutMs,
      (elapsedMs) => {
        emitLifecycle(input, "http.stream.first_event_timeout", {
          adapter: this.kind,
          session_id: sessionId,
          elapsed_ms: elapsedMs,
        });
        return new Error(`opencode-acp: no stream events within ${String(firstEventTimeoutMs)}ms`);
      },
    );
    const inactivityController = new AbortController();
    const inactivity = createRollingInactivityHandle(inactivityController);
    const clientSignal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([streamAbort.signal, inactivityController.signal])
        : streamAbort.signal;
    const client = this.deps.createClient({
      baseUrl,
      signal: clientSignal,
    });
    const messageStream = client.sendMessage(sessionId, input.prompt, {
      model: this.opts.model,
      tools: [],
      directory: cwd,
      workspace: workspaceId,
    });
    const iterator = messageStream[Symbol.asyncIterator]();
    const inactivityError = (timeoutMs: number): Error =>
      new Error(`opencode-acp: no wire activity for ${String(timeoutMs)}ms`);
    const nextEvent = async (): Promise<IteratorResult<AcpEvent, void>> => {
      if (!sawEvent) {
        try {
          const result = await awaitWithSignal(iterator.next(), clientSignal);
          if (!result.done) {
            sawEvent = true;
            streamAbort.clearTimer();
            inactivity.arm(inactivityTimeoutMs, inactivityError);
          }
          return result;
        } catch (err) {
          void iterator.return?.();
          throw err;
        }
      }
      try {
        const result = await awaitWithSignal(iterator.next(), clientSignal);
        if (!result.done) {
          inactivity.arm(inactivityTimeoutMs, inactivityError);
        }
        return result;
      } catch (err) {
        void iterator.return?.();
        throw err;
      }
    };
    try {
      streamLoop: for (;;) {
        const next = await nextEvent();
        if (next.done) break;
        const evtRaw = next.value;
        const evt = asWireEvent(evtRaw);
        const props = evt.properties;
        lastEventType = typeof evt.type === "string" ? evt.type : "unknown";
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
            sawIdle = true;
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
    } finally {
      inactivity.cleanup();
      streamAbort.cleanup();
    }

    if (!sawIdle && text.length === 0) {
      throw new Error(`opencode-acp: stream ended without session.idle after ${lastEventType}`);
    }

    yield { type: "done", result: { text } };
  }
}

export type { AcpEvent };
