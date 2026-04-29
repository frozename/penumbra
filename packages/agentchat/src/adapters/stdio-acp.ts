import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import type { McpServer } from './acp-types.js';
import { executeReadTextFile, ReadTextFileError } from './acp-fs.js';
import { StdioAcpClient } from './stdio-acp-client.js';
import { startStdioAcpServer, type StdioAcpHandle, type StartStdioAcpServerOptions } from './stdio-acp-server.js';
import type { CapturePort } from '../worker/capture-port.js';

const ERROR_CODE_MAP: Record<string, number> = {
  outside_worktree: -32001,
  not_a_file: -32002,
  io_error: -32003,
  operation_rejected: -32004,
  terminal_not_found: -32005,
  terminal_cap_exceeded: -32006,
  edit_miss: -32010,
  edit_ambiguous: -32011,
};

function mapWriteToolsError(err: unknown): Error {
  if (err instanceof Error && 'code' in err && typeof (err as any).code === 'string') {
    const code = ERROR_CODE_MAP[(err as any).code] ?? -32099;
    const mapped = new Error(err.message);
    (mapped as any).code = code;
    return mapped;
  }
  return err instanceof Error ? err : new Error(String(err));
}

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
  /** When true, advertises fs.writeTextFile and handles fs/write_text_file requests. */
  fsWriteTextFile?: boolean;
  /** When true, advertises terminal/* and handles terminal requests. */
  terminal?: boolean;
  capturePort?: CapturePort;
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
      if (this.opts.fsWriteTextFile) {
        client.onRequest('fs/write_text_file', async (params: any) => {
          if (!input.executor) throw new Error('fs/write_text_file: no executor in dispatch input');
          try {
            await input.executor.writeTextFile(
              { path: params?.path, content: params?.content },
              {
                toolName: 'fs.write_text_file',
                rawInput: { path: params?.path, content_bytes: Buffer.byteLength(params?.content ?? '', 'utf8') },
                dispatchId: (input as any).dispatchId ?? (input as any).handoff_id ?? 'unknown',
              },
            );
            return {};
          } catch (err) {
            throw mapWriteToolsError(err);
          }
        });
      }
      if (this.opts.terminal) {
        client.onRequest('terminal/create', async (params: any) => {
          if (!input.executor) throw new Error('terminal/create: no executor');
          try {
            return await input.executor.terminalCreate(
              { command: params?.command, argv: params?.args, cwd: params?.cwd, output_byte_limit: params?.output_byte_limit },
              {
                toolName: 'terminal.create',
                rawInput: { argv: params?.args ?? null, cmd: params?.command ?? null, cwd: params?.cwd ?? '.' },
                dispatchId: (input as any).dispatchId ?? (input as any).handoff_id ?? 'unknown',
              },
            );
          } catch (err) {
            throw mapWriteToolsError(err);
          }
        });
        client.onRequest('terminal/output', async (params: any) => {
          if (!input.executor) throw new Error('terminal/output: no executor');
          try {
            return await input.executor.terminalOutput({ terminal_id: params?.terminal_id });
          } catch (err) {
            throw mapWriteToolsError(err);
          }
        });
        client.onRequest('terminal/wait_for_exit', async (params: any) => {
          if (!input.executor) throw new Error('terminal/wait_for_exit: no executor');
          try {
            return await input.executor.terminalWaitForExit({ terminal_id: params?.terminal_id });
          } catch (err) {
            throw mapWriteToolsError(err);
          }
        });
        client.onRequest('terminal/release', async (params: any) => {
          if (!input.executor) throw new Error('terminal/release: no executor');
          try {
            await input.executor.terminalRelease({ terminal_id: params?.terminal_id });
            return {};
          } catch (err) {
            throw mapWriteToolsError(err);
          }
        });
        client.onRequest('terminal/kill', async (params: any) => {
          if (!input.executor) throw new Error('terminal/kill: no executor');
          try {
            await input.executor.terminalKill({ terminal_id: params?.terminal_id });
            return {};
          } catch (err) {
            throw mapWriteToolsError(err);
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

          const toolName: string | null =
            (typeof params?.toolCall?.title === 'string' && params.toolCall.title)
            || (typeof params?.toolCall?.name === 'string' && params.toolCall.name)
            || null;
          if (!toolName) {
            return { outcome: { outcome: 'cancelled' } };
          }
          let decision: 'approve' | 'reject' = 'approve';
          try {
            decision = await input.requestPermission({
              toolName,
              rawInput: params?.toolCall?.rawInput ?? params?.toolCall ?? null,
              dispatchId: input.handoff_id ?? (input.conversation?.id ?? 'unknown'),
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
      if (this.opts.fsReadTextFile || this.opts.fsWriteTextFile) {
        clientCapabilities.fs = {
          ...(this.opts.fsReadTextFile ? { readTextFile: true } : {}),
          ...(this.opts.fsWriteTextFile ? { writeTextFile: true } : {}),
        };
      }
      if (this.opts.terminal) {
        clientCapabilities.terminal = true;
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
      const mcpServers = this.opts.mcpServers ?? [];
      // Scope PENUMBRA_HANDOFF_ID injection to the penumbra-mcp server only —
      // never leak the dispatch identifier to third-party stdio MCPs. We
      // identify it by command-arg path (binary file ending in penumbra-mcp.ts
      // or penumbra-mcp), which is yaml-independent. The agentchat.yaml
      // convention names this server simply `penumbra`, so a name-only check
      // would silently miss it.
      const isPenumbraMcp = (s: any): boolean => {
        if (s.command === undefined) return false;
        const argsArr: string[] = Array.isArray(s.args) ? s.args : [];
        const haystack = [s.name ?? '', s.command, ...argsArr].join(' ');
        return /penumbra-mcp(\.ts|\.js)?($|[\s/])/.test(haystack);
      };
      const mcpServersWithEnv = input.handoff_id
        ? mcpServers.map((s: any) =>
            isPenumbraMcp(s)
              ? {
                  ...s,
                  env: [
                    ...((s.env ?? []) as any[]).filter((e: any) => e.name !== 'PENUMBRA_HANDOFF_ID'),
                    { name: 'PENUMBRA_HANDOFF_ID', value: input.handoff_id },
                  ],
                }
              : s,
          )
        : mcpServers;

      const sessionParams: any = {
        cwd,
        mcpServers: mcpServersWithEnv,
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
              this.opts.capturePort?.emit({ kind: 'agent_message_chunk', content: content.text });
            }
            break;
          }
          case 'agent_thought_chunk': {
            const content = update.content;
            if (content?.type === 'text' && typeof content.text === 'string') {
              this.opts.capturePort?.emit({ kind: 'agent_thought_chunk', content: content.text });
            }
            break;
          }
          case 'tool_call': {
            this.opts.capturePort?.emit({
              kind: 'tool_call',
              toolCallId: update.toolCallId,
              status: update.status,
              input: update.input,
            });
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
            if (!this.opts.fsReadTextFile && !this.opts.fsWriteTextFile && !this.opts.terminal) {
              server?.kill();
              toolUseRejector?.(new Error('stdio-acp: tool use not yet supported in this adapter phase'));
            }
            break;
          }
          case 'tool_call_update': {
            this.opts.capturePort?.emit({
              kind: 'tool_call_update',
              toolCallId: update.toolCallId,
              status: update.status,
              output: update.output,
            });
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
            if (!this.opts.fsReadTextFile && !this.opts.fsWriteTextFile && !this.opts.terminal) {
              server?.kill();
              toolUseRejector?.(new Error('stdio-acp: tool use not yet supported in this adapter phase'));
            }
            break;
          }
          case 'usage_update': {
            const used = typeof update.used === 'number' ? update.used : NaN;
            const size = typeof update.size === 'number' ? update.size : NaN;
            if (!Number.isFinite(used) || !Number.isFinite(size)) break;
            this.opts.capturePort?.emit({
              kind: 'usage_update',
              used,
              size,
              cost: update.cost,
            });
            break;
          }
          // ignore: agent_thought_chunk, plan, available_commands_update, etc.
        }
      });

      const promptPromise = client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      });

      let promptTimeout: NodeJS.Timeout | null = null;
      const promptTimeoutPromise = new Promise<never>((_, reject) => {
        promptTimeout = setTimeout(() => {
          reject(
            new Error(
              `stdio-acp: session/prompt timed out after ${requestTimeoutMs}ms (agent unresponsive — likely auth or capability negotiation hang)`
            )
          );
        }, requestTimeoutMs);
      });

      try {
        // PromptResponse carries stopReason; the actual text lives in accumulatedText.
        await Promise.race([promptPromise, toolUseRejection, promptTimeoutPromise]);
      } finally {
        if (promptTimeout) clearTimeout(promptTimeout);
      }

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
