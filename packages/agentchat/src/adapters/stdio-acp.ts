import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import type { McpServer } from './acp-types.js';
import { executeReadTextFile, ReadTextFileError } from './acp-fs.js';
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
  /** When true, advertises fs.readTextFile and handles fs/read_text_file requests. */
  fsReadTextFile?: boolean;
  mcpServers?: McpServer[];
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
      if (this.opts.fsReadTextFile) {
        client.onRequest('fs/read_text_file', async (params: any) => {
          try {
            return await executeReadTextFile(
              { path: params?.path, line: params?.line, limit: params?.limit },
              cwd,
            );
          } catch (err) {
            if (err instanceof ReadTextFileError) {
              throw new Error(`fs/read_text_file ${err.code}: ${err.message}`);
            }
            throw err;
          }
        });
      }

      // Phase 1a/1b.1 stub: auto-allow permission requests when ANY client
      // capability is advertised. The agent calls session/request_permission
      // before invoking sensitive tools (its own internal Read/Bash, MCP tool
      // calls, etc.). Without a handler, the JSON-RPC -32601 reply makes the
      // agent abort its turn.
      //
      // Phase 1c will replace this with the canonical handoff.approve flow
      // (operator pause + redirect/reject via existing MCP tools). For now,
      // since the dispatch is already gated by chain_trust_mode='all' at the
      // daemon level, auto-selecting allow_always is the operator's intent.
      const hasClientCapability =
        this.opts.fsReadTextFile ||
        (this.opts.mcpServers !== undefined && this.opts.mcpServers.length > 0);
      if (hasClientCapability) {
        client.onRequest('session/request_permission', async (params: any) => {
          const options = Array.isArray(params?.options) ? params.options : [];

          if (!input.requestPermission) {
            const chosen =
              options.find((o: any) => o?.kind === 'allow_always') ??
              options.find((o: any) => o?.kind === 'allow_once') ??
              options[0];
            if (!chosen?.optionId) {
              return { outcome: { outcome: 'cancelled' } };
            }
            return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
          }

          const allowOption =
            options.find((o: any) => o?.kind === 'allow_always') ??
            options.find((o: any) => o?.kind === 'allow_once') ??
            options.find((o: any) => o?.optionId);
          const rejectOption =
            options.find((o: any) => o?.kind === 'reject_always') ??
            options.find((o: any) => o?.kind === 'reject_once');

          let decision: 'approve' | 'reject' = 'approve';
          try {
            decision = await input.requestPermission({
              toolName: params?.toolCall?.title ?? params?.toolCall?.name ?? 'unknown',
              rawInput: params?.toolCall?.rawInput ?? params?.toolCall ?? null,
            });
          } catch {
            decision = 'reject';
          }

          if (decision === 'approve' && allowOption?.optionId) {
            return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
          }
          if (decision === 'reject' && rejectOption?.optionId) {
            return { outcome: { outcome: 'selected', optionId: rejectOption.optionId } };
          }
          return { outcome: { outcome: 'cancelled' } };
        });
      }

      // 1. Initialize
      const clientCapabilities: any = {};
      if (this.opts.fsReadTextFile) {
        clientCapabilities.fs = { readTextFile: true };
      }
      const initResponse = await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities,
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
        mcpServers: this.opts.mcpServers ?? [],
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
            // tool_call SessionUpdates are agent-side observability for the
            // agent's own internal tools (its built-in Read/Bash/etc.). They
            // are NOT requests for the client to execute work — those go via
            // JSON-RPC requests like fs/read_text_file (handled by onRequest).
            //
            // When the adapter advertises a client capability (currently only
            // fsReadTextFile in Phase 1b.1), we must let the turn continue so
            // the agent can actually USE the capability via its RPC path.
            // Killing here aborts the dispatch before the agent gets that
            // chance.
            //
            // When no client capability is advertised, the adapter is in
            // single-turn echo mode — preserve the original kill-on-tool-call
            // behavior to surface the limitation clearly rather than letting
            // the agent run a multi-turn tool loop with no client support.
            if (!this.opts.fsReadTextFile) {
              server?.kill();
              toolUseRejector?.(new Error('stdio-acp: tool use not yet supported in this adapter phase'));
            }
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
