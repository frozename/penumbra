import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { StdioAcpClient } from './stdio-acp-client.js';
import { startStdioAcpServer, type StdioAcpHandle, type StartStdioAcpServerOptions } from './stdio-acp-server.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface StdioAcpOptions {
  binary: string;
  args?: string[];
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class StdioAcpAdapter implements Adapter {
  readonly kind = 'stdio-acp';

  constructor(
    private readonly opts: StdioAcpOptions,
    private readonly deps = {
      startServer: startStdioAcpServer,
      createClient: (h: StdioAcpHandle) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
    },
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    let result: DispatchOutput | null = null;
    for await (const event of this.dispatchStream(input)) {
      if (event.type === 'done') {
        result = event.result;
      }
    }
    if (!result) throw new Error('stdio-acp: stream ended without result');
    return result;
  }

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const cwd = this.opts.cwd ?? process.cwd();
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let server: StdioAcpHandle | null = null;

    try {
      server = await this.deps.startServer({
        binary: this.opts.binary,
        args: this.opts.args,
        cwd,
        env: this.opts.env,
        signal: input.signal,
      });

      const client = this.deps.createClient(server);

      // 1. Initialize
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'penumbra', version: '1.0.0' },
      });

      // 2. New Session
      const session = await client.request('newSession', {
        cwd,
        model: this.opts.model,
      });
      const sessionId = session.sessionId;

      // 3. Prompt
      let toolUseError: Error | null = null;
      client.on('tool.call.requested', () => {
        toolUseError = new Error('stdio-acp: tool use not yet supported in this adapter phase');
        server?.kill();
      });

      const responsePromise = client.request('prompt', {
        sessionId,
        prompt: input.prompt,
      });

      const response = await Promise.race([
        responsePromise,
        new Promise((_, reject) => {
          const check = setInterval(() => {
            if (toolUseError) {
              clearInterval(check);
              reject(toolUseError);
            }
          }, 10);
        }),
      ]);

      yield {
        type: 'done',
        result: {
          text: (response as any).text,
        },
      };
    } finally {
      if (server) {
        server.kill();
      }
    }
  }
}
