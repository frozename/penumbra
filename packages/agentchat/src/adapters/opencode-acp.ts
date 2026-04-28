import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { AcpClient, type AcpClientOptions } from './acp-client.js';
import { startAcpServer, type AcpServerHandle, type StartAcpServerOptions } from './acp-server.js';
import type { AcpCreateSessionRequest, AcpEvent, McpServer } from './acp-types.js';
import { prepareOpencodeMcpConfigDir } from './opencode-mcp-config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface OpencodeAcpOptions {
  model: string;
  cwd?: string;
  opencodeBinary?: string;
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
  mcpServers?: McpServer[];
}

type AcpClientLike = Pick<AcpClient, 'openSession' | 'sendMessage'>;

interface OpencodeAcpDeps {
  startServer: (opts: StartAcpServerOptions) => Promise<AcpServerHandle>;
  createClient: (opts: AcpClientOptions) => AcpClientLike;
}

function createDispatchAbortSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let timeoutError: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortWith = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const onParentAbort = () => {
    abortWith(parent.reason);
  };

  if (parent.aborted) {
    onParentAbort();
  } else {
    parent.addEventListener('abort', onParentAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutError = new Error(`opencode-acp request timed out after ${timeoutMs}ms`);
      timeoutError.name = 'AbortError';
      abortWith(timeoutError);
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timeoutError() {
      return timeoutError;
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

export class OpencodeAcpAdapter implements Adapter {
  readonly kind = 'opencode-acp';

  constructor(
    private readonly opts: OpencodeAcpOptions,
    private readonly deps: OpencodeAcpDeps = {
      startServer: startAcpServer,
      createClient: (clientOpts) => new AcpClient(clientOpts),
    },
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    let result: DispatchOutput | null = null;

    for await (const event of this.dispatchStream(input)) {
      if (event.type === 'done') {
        result = event.result;
      }
    }

    if (!result) {
      throw new Error('opencode-acp: stream ended without a final result');
    }

    return result;
  }

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const cwd = this.opts.cwd ?? process.cwd();
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const requestAbort = createDispatchAbortSignal(input.signal, requestTimeoutMs);
    let server: AcpServerHandle | null = null;
    let xdgCleanup: (() => Promise<void>) | null = null;
    let extraEnv: Record<string, string> | undefined;

    if (this.opts.mcpServers && this.opts.mcpServers.length > 0) {
      const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(this.opts.mcpServers);
      extraEnv = { XDG_CONFIG_HOME: xdgConfigHome };
      xdgCleanup = cleanup;
    }

    try {
      server = await this.deps.startServer({
        cwd,
        pure: true,
        signal: requestAbort.signal,
        opencodeBinary: this.opts.opencodeBinary ?? 'opencode',
        bootTimeoutMs: this.opts.bootTimeoutMs,
        ...(extraEnv ? { env: extraEnv } : {}),
      });

      const client = this.deps.createClient({
        baseUrl: server.baseUrl,
        signal: requestAbort.signal,
      });
      const sessionReq: AcpCreateSessionRequest = { cwd };
      const { sessionId, workspaceId } = await client.openSession(sessionReq);

      // OpenCode emits SSE events as { type, properties: {...} }. The "text"
      // we want is delivered via message.part.delta with properties.field === 'text'
      // — but the model also streams reasoning content as a separate part of type
      // 'reasoning'. We track partID → part type from message.part.updated events
      // and only accumulate deltas for parts whose type is 'text'.
      // Stream ends on session.idle (turn complete) or session.error.
      const partTypeById = new Map<string, string>();
      let text = '';
      streamLoop: for await (const evtRaw of client.sendMessage(sessionId, input.prompt, {
        model: this.opts.model,
        tools: [],
        directory: cwd,
        workspace: workspaceId,
      })) {
        const evt = evtRaw as any;
        const props = evt?.properties;
        switch (evt?.type) {
          case 'message.part.updated': {
            const partId = props?.part?.id;
            const partType = props?.part?.type;
            if (typeof partId === 'string' && typeof partType === 'string') {
              partTypeById.set(partId, partType);
            }
            break;
          }
          case 'message.part.delta': {
            if (props?.field !== 'text') break;
            const partId = props?.partID;
            // First delta on a part may arrive before the part.updated event
            // for it; default-treat unknown parts as 'text' (the common case).
            const partType = partId ? partTypeById.get(partId) ?? 'text' : 'text';
            if (partType !== 'text') break;
            const delta = typeof props?.delta === 'string' ? props.delta : '';
            if (!delta) break;
            text += delta;
            yield { type: 'delta', text: delta };
            break;
          }
          case 'session.error': {
            const message = props?.error?.data?.message ?? props?.error?.name ?? 'unknown';
            throw new Error(`opencode-acp: session.error — ${message}`);
          }
          case 'session.idle':
            // Turn finished cleanly. Stop consuming the stream.
            break streamLoop;
          default:
            // Other events (server.connected, session.status, session.diff,
            // server.heartbeat, etc.) are ignored.
            break;
        }
      }

      yield { type: 'done', result: { text } };
    } catch (err) {
      if (
        requestAbort.timeoutError &&
        requestAbort.signal.aborted &&
        err instanceof Error &&
        err.name === 'AbortError'
      ) {
        throw requestAbort.timeoutError;
      }
      throw err;
    } finally {
      requestAbort.cleanup();
      if (server) {
        await server.kill().catch(() => {});
      }
      if (xdgCleanup) {
        await xdgCleanup();
      }
    }
  }
}

export type { AcpEvent };
