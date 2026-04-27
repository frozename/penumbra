import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { AcpClient, type AcpClientOptions } from './acp-client.js';
import { startAcpServer, type AcpServerHandle, type StartAcpServerOptions } from './acp-server.js';
import type { AcpCreateSessionRequest, AcpEvent } from './acp-types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface OpencodeAcpOptions {
  model: string;
  cwd?: string;
  opencodeBinary?: string;
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
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

    try {
      server = await this.deps.startServer({
        cwd,
        pure: true,
        signal: requestAbort.signal,
        opencodeBinary: this.opts.opencodeBinary ?? 'opencode',
        bootTimeoutMs: this.opts.bootTimeoutMs,
      });

      const client = this.deps.createClient({
        baseUrl: server.baseUrl,
        signal: requestAbort.signal,
      });
      const sessionReq: AcpCreateSessionRequest = { cwd };
      const { sessionId, workspaceId } = await client.openSession(sessionReq);

      let text = '';
      for await (const event of client.sendMessage(sessionId, input.prompt, {
        model: this.opts.model,
        tools: [],
        directory: cwd,
        workspace: workspaceId,
      })) {
        if (event.type === 'message.part.delta') {
          text += event.delta;
          yield { type: 'delta', text: event.delta };
          continue;
        }

        if (event.type === 'tool.call.requested') {
          throw new Error(
            `opencode-acp: tool calls not supported in Commit 3 (requested ${event.tool})`,
          );
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
    }
  }
}

export type { AcpEvent };
