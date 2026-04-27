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
  unsetEnv?: string[];
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
  authMethodId?: string;
  framing?: 'newline' | 'content-length';
}

export class StdioAcpAdapter implements Adapter {
  readonly kind = 'stdio-acp';

  constructor(
    private readonly opts: StdioAcpOptions,
    private readonly deps = {
      startServer: startStdioAcpServer,
      createClient: (h: StdioAcpHandle) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout, framing: opts.framing }),
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
      const mergedEnv: Record<string, string> = { ...process.env, ...(this.opts.env ?? {}) } as Record<string, string>;
      for (const key of this.opts.unsetEnv ?? []) delete mergedEnv[key];

      server = await this.deps.startServer({
        binary: this.opts.binary,
        args: this.opts.args,
        cwd,
        env: mergedEnv,
        signal: input.signal,
      });

      const client = this.deps.createClient(server);

      // 1. Initialize
      const initResponse = await client.request('initialize', {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: 'penumbra', version: '1.0.0' },
      });

      // 1.5 Authenticate
      const authMethods = initResponse.authMethods ?? [];
      if (authMethods.length > 0) {
        let chosenAuthId = this.opts.authMethodId;
        if (!chosenAuthId) {
          const satisfiedEnvVar = authMethods.find((m: any) => m.type === 'env_var' && m.vars?.every((v: any) => !!mergedEnv[v.name]));
          if (satisfiedEnvVar) {
            chosenAuthId = satisfiedEnvVar.id;
          } else {
            const nonEnvVar = authMethods.find((m: any) => m.type !== 'env_var');
            chosenAuthId = nonEnvVar ? nonEnvVar.id : authMethods[0].id;
          }
        }
        await client.request('authenticate', { methodId: chosenAuthId });
      }

      // 2. New Session
      const sessionParams: any = {
        cwd,
        mcpServers: [],
      };
      if (this.opts.model) {
        sessionParams.model = this.opts.model;
      }
      const session = await client.request('session/new', sessionParams);
      const sessionId = session.sessionId;

      // 3. Prompt — ACP is streaming-first per @agentclientprotocol/sdk:
      //    - prompt: PromptRequest carries `prompt: Array<ContentBlock>`, not a string
      //    - response: PromptResponse only carries `stopReason` — text is delivered via
      //      `session/update` notifications during the turn (each is a SessionUpdate
      //      whose `sessionUpdate === "agent_message_chunk"` carries a ContentChunk
      //      with `content: TextContent`). Accumulate those.
      let accumulatedText = '';
      let toolUseRejector: ((err: Error) => void) | null = null;
      const toolUseRejection = new Promise<never>((_, reject) => {
        toolUseRejector = reject;
      });

      client.on('session/update', (params: any) => {
        const update = params?.update;
        if (!update || typeof update !== 'object') return;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const content = update.content;
            if (content?.type === 'text' && typeof content.text === 'string') {
              accumulatedText += content.text;
            }
            break;
          }
          case 'tool_call':
          case 'tool_call_update':
            server?.kill();
            toolUseRejector?.(new Error('stdio-acp: tool use not yet supported in this adapter phase'));
            break;
          // ignore: agent_thought_chunk, plan, available_commands_update, etc.
        }
      });

      const promptPromise = client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      });

      // PromptResponse carries stopReason; the actual text lives in accumulatedText.
      await Promise.race([promptPromise, toolUseRejection]);

      yield {
        type: 'done',
        result: {
          text: accumulatedText,
        },
      };
    } finally {
      if (server) {
        server.kill();
      }
    }
  }
}
