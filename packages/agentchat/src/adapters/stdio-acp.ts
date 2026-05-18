import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import type { DispatchEventInput } from '@penumbra/core';
import type { McpServer } from './acp-types.js';
import { executeReadTextFile, ReadTextFileError } from './acp-fs.js';
import { StdioAcpClient } from './stdio-acp-client.js';
import { startStdioAcpServer, type StdioAcpHandle, type StartStdioAcpServerOptions } from './stdio-acp-server.js';
import type { CapturePort } from '../worker/capture-port.js';
import { registerSession, unregisterSession } from '../worker/session-registry.js';

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

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const LONG_LIVED_SELF_TOOL_NAMES = [
  'long_lived_self_state_get',
  'long_lived_self_state_set',
  'long_lived_self_pending_actions',
] as const;
const CLAUDE_HOST_ENV_LITERAL_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_EFFORT',
  'CLAUDE_PLUGIN_DATA',
]);

export type HostEnvProvider = 'claude';

export type HostEnvPolicy = Partial<Record<HostEnvProvider, boolean>>;

type HostEnvPredicate = (key: string) => boolean;

export const HOST_ENV_PREDICATES: Record<HostEnvProvider, HostEnvPredicate> = {
  claude: (key) => key.startsWith('CLAUDE_CODE_') || CLAUDE_HOST_ENV_LITERAL_KEYS.has(key),
};

export function isClaudeHostEnvKey(key: string): boolean {
  return HOST_ENV_PREDICATES.claude(key);
}

export function resolveHostEnvPolicy(
  opts: Pick<StdioAcpOptions, 'hostEnvPolicy' | 'sanitizeClaudeHostEnv'>,
): HostEnvPolicy {
  const policy: HostEnvPolicy = { ...(opts.hostEnvPolicy ?? {}) };
  if (opts.sanitizeClaudeHostEnv && policy.claude === undefined) {
    policy.claude = true;
  }
  for (const [key, enabled] of Object.entries(policy)) {
    if (!enabled) continue;
    if (!(key in HOST_ENV_PREDICATES)) {
      throw new Error(
        `stdio-acp: hostEnvPolicy has unknown provider "${key}" set to true. Known providers: ${Object.keys(HOST_ENV_PREDICATES).join(', ')}.`,
      );
    }
  }
  return policy;
}

export function shouldScrubHostEnvKey(key: string, policy: HostEnvPolicy): boolean {
  for (const provider of Object.keys(policy) as HostEnvProvider[]) {
    if (!policy[provider]) continue;
    const predicate = HOST_ENV_PREDICATES[provider];
    if (predicate?.(key)) return true;
  }
  return false;
}
const PENUMBRA_MCP_INJECTED_ENV_KEYS = new Set([
  'PENUMBRA_HANDOFF_ID',
  'PENUMBRA_LONG_LIVED_AGENT_ID',
  'PENUMBRA_LONG_LIVED_TICK_ID',
  // Note: PENUMBRA_MCP_TOOL_ALLOWLIST is intentionally NOT in this strip-list.
  // For long_lived_tick dispatches the adapter STILL appends its own value
  // after the user-provided one (last-wins on env merge), so dispatch-side
  // injection is unaffected. But for manual chain_start tests (and any
  // non-long-lived dispatch path), the user's yaml-level allowlist now
  // passes through — without this, the schema-injection bloat fix has no
  // way to land outside the cron tick path.
]);

function buildLongLivedMcpEnv(input: DispatchInput): Array<{ name: string; value: string }> {
  const session = input.long_lived_session;
  if (!session || session.dispatch_kind !== 'long_lived_tick') return [];

  const stripPenumbraPrefix = (name: string) =>
    name.startsWith('penumbra:') ? name.slice('penumbra:'.length) : name;
  const allowlist = new Set(
    (session.mcp_tool_allowlist ?? [])
      .map((name) => name.trim())
      .map(stripPenumbraPrefix)
      .filter((name) => name.length > 0),
  );
  for (const toolName of LONG_LIVED_SELF_TOOL_NAMES) {
    allowlist.add(toolName);
  }

  const envEntries: Array<{ name: string; value: string }> = [
    { name: 'PENUMBRA_MCP_TOOL_ALLOWLIST', value: [...allowlist].join(',') },
  ];
  if (session.agent_id && session.agent_id.length > 0) {
    envEntries.push({ name: 'PENUMBRA_LONG_LIVED_AGENT_ID', value: session.agent_id });
  }
  if (session.tick_id && session.tick_id.length > 0) {
    envEntries.push({ name: 'PENUMBRA_LONG_LIVED_TICK_ID', value: session.tick_id });
  }
  return envEntries;
}

function emitLifecycle(input: DispatchInput, kind: DispatchEventInput['kind'], meta?: Record<string, unknown>): void {
  if (!input.eventContext || !input.onEvent) return;
  input.onEvent({
    handoff_id: input.eventContext.handoffId,
    worker_id: input.eventContext.workerId,
    source: 'worker',
    kind,
    ts: new Date().toISOString(),
    meta,
  });
}

function supportsClientCapability(opts: Pick<StdioAcpOptions, 'fsReadTextFile' | 'fsWriteTextFile' | 'terminal' | 'mcpServers'>): boolean {
  return (
    !!opts.fsReadTextFile ||
    !!opts.fsWriteTextFile ||
    !!opts.terminal ||
    (opts.mcpServers !== undefined && opts.mcpServers.length > 0)
  );
}

const SHELL_COMMAND_PREFIXES = [
  'bun ',
  'git ',
  'npm ',
  'npx ',
  'pnpm ',
  'node ',
  'find ',
  'grep ',
  'ls ',
  'cat ',
  'cd ',
  'mkdir ',
  'rm ',
  'cp ',
  'mv ',
  'sed ',
  'awk ',
  'echo ',
  'curl ',
  'tsc',
  'bash ',
  'sh ',
] as const;

function looksLikeShellCommand(name: string | null | undefined): boolean {
  if (!name) return false;
  if (/\s/.test(name)) return true;
  return SHELL_COMMAND_PREFIXES.some((prefix) => name.startsWith(prefix));
}

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
  /**
   * Override `settingSources` for the claude-agent-acp / claude-agent-sdk
   * `query()` call. Default in the SDK is `["user", "project", "local"]`, which
   * causes .claude/settings.json files at each scope to be merged. Note this
   * does NOT control MCP server loading from ~/.claude.json — use
   * `claudeCodeStrictMcpConfig` for that.
   */
  claudeCodeSettingSources?: ('user' | 'project' | 'local')[];
  /**
   * When true, threads `--strict-mcp-config` to the claude CLI: only the
   * per-session mcpServers list above is honored. Drops user-global MCP servers
   * from `~/.claude.json` (i.e., everything `claude mcp list` shows) and plugin
   * MCPs from `~/.claude/plugins/`. Without this, the SDK merges the per-session
   * list on TOP of the global one — bloating the system prompt with every
   * registered tool schema.
   */
  claudeCodeStrictMcpConfig?: boolean;
  /**
   * Forwarded to `_meta.claudeCode.options.allowedTools` on session/new.
   * Restricts the claude-agent-sdk's advertised tool surface to this
   * whitelist (supports glob patterns like `mcp__ha__*`). When unset, the
   * SDK uses its default (all builtin + every registered MCP tool).
   * Useful for long-lived agents that only need a narrow MCP slice -
   * dropping unused builtin tool schemas shrinks the system prompt.
   */
  claudeCodeAllowedTools?: string[];
  /**
   * Forwarded to `_meta.claudeCode.options.tools` on session/new. Controls
   * which builtin Claude Code tools are advertised in the system prompt.
   * - When unset: SDK defaults to `{ type: "preset", preset: "claude_code" }`
   *   (Bash, Read/Write/Edit, Grep, Glob, Task, WebFetch, TodoWrite,
   *   NotebookEdit, ...) - ~22K tokens of schema bloat.
   * - When set to `[]`: drops the entire builtin preset. Useful for
   *   long-lived agents that only need MCP tools (e.g., home-mgmt).
   * - When set to a non-empty `string[]`: explicit whitelist of builtin
   *   tool names to expose.
   */
  claudeCodeTools?: string[];
  /**
   * Forwarded to `_meta.claudeCode.options.disallowedTools` on session/new.
   * Complement to `claudeCodeAllowedTools`; the SDK applies disallow over
   * allow.
   */
  claudeCodeDisallowedTools?: string[];
  /**
   * Per-provider host-env scrub policy. When a provider key is true, env vars
   * matching that provider's host-env predicate are stripped from the inherited
   * env BEFORE opts.env is overlaid, so explicit opts.env entries always win.
   * Add a new provider key + predicate entry to extend the registry.
   */
  hostEnvPolicy?: HostEnvPolicy;
  /**
   * @deprecated Use `hostEnvPolicy: { claude: true }`. Preserved as a one-tick
   * alias for yaml backwards-compat; resolved into hostEnvPolicy when
   * hostEnvPolicy is unset.
   */
  sanitizeClaudeHostEnv?: boolean;
}

interface StdioAcpThoughtCapture {
  recordThought: (input: {
    handoffId: string;
    adapter: 'stdio-acp';
    agentName: string;
    text: string;
    tokenCount?: number;
    ts?: string;
  }) => void;
}

interface StdioAcpAdapterDeps {
  startServer: (opts: StartStdioAcpServerOptions) => Promise<StdioAcpHandle>;
  createClient: (handle: StdioAcpHandle) => StdioAcpClient;
  thoughtCapture?: StdioAcpThoughtCapture;
}

export class StdioAcpAdapter implements Adapter {
  readonly kind = 'stdio-acp';

  constructor(
    private readonly opts: StdioAcpOptions,
    private readonly deps: StdioAcpAdapterDeps = {
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
      const inheritedEnv: Record<string, string> = { ...process.env } as Record<string, string>;
      const hostEnvPolicy = resolveHostEnvPolicy(this.opts);
      if (Object.values(hostEnvPolicy).some(Boolean)) {
        for (const key of Object.keys(inheritedEnv)) {
          if (shouldScrubHostEnvKey(key, hostEnvPolicy)) delete inheritedEnv[key];
        }
      }
      const mergedEnv: Record<string, string> = { ...inheritedEnv, ...(this.opts.env ?? {}) };
      for (const key of this.opts.unsetEnv ?? []) delete mergedEnv[key];

      server = await this.deps.startServer({
        binary: this.opts.binary,
        args: this.opts.args,
        cwd,
        env: mergedEnv,
        signal: input.signal,
      });
      emitLifecycle(input, 'acp.server.start', {
        adapter: this.kind,
        binary: this.opts.binary,
        pid: server.pid,
      });

      const client = this.deps.createClient(server);

      // Idle-watchdog state. Hoisted above the onRequest registrations so
      // every incoming JSON-RPC request can re-arm liveness — not just
      // session/update notifications. Pre-prompt arming is a no-op because
      // armPromptTimeout early-returns when promptTimeoutRejector is null.
      let promptTimeout: ReturnType<typeof setTimeout> | null = null;
      let promptTimeoutRejector: ((err: Error) => void) | null = null;
      const clearPromptTimeout = () => {
        if (promptTimeout) {
          clearTimeout(promptTimeout);
          promptTimeout = null;
        }
      };
      const armPromptTimeout = () => {
        if (!promptTimeoutRejector) return;
        clearPromptTimeout();
        promptTimeout = setTimeout(() => {
          const tail = server?.getStderrTail?.() ?? '';
          const tailHint = tail ? `\n[child stderr tail]\n${tail}` : '';
          promptTimeoutRejector?.(
            new Error(
              `stdio-acp: no wire activity (session/update or onRequest) for ${requestTimeoutMs}ms — agent stalled mid-turn${tailHint}`,
            ),
          );
        }, requestTimeoutMs);
      };

      if (this.opts.fsReadTextFile) {
        client.onRequest('fs/read_text_file', async (params: any) => {
          armPromptTimeout();
          try {
            return await executeReadTextFile(
              { path: params?.path, line: params?.line, limit: params?.limit },
              cwd,
            );
          } catch (err) {
            if (err instanceof ReadTextFileError) {
              // Format the error message so client-side string-matchers
              // recognise file-not-found correctly. Gemini-cli's
              // AcpFileSystemService.normalizeFileSystemError checks for
              // 'ENOENT' / 'No such file' / 'Resource not found' / 'does not exist'
              // — without one of these substrings it treats our error as a
              // generic write-blocking failure rather than "file does not
              // exist", which silently breaks every gemini-acp write tool
              // (the write-file tool calls readTextFile to check existence
              // before writing, and a non-ENOENT-shaped error returns early
              // with `error` set, never attempting the write).
              if (err.code === 'not_found') {
                throw new Error(`ENOENT: No such file or directory: ${err.message}`);
              }
              throw new Error(`fs/read_text_file ${err.code}: ${err.message}`);
            }
            throw err;
          } finally {
            armPromptTimeout();
          }
        });
      }
      if (this.opts.fsWriteTextFile) {
        client.onRequest('fs/write_text_file', async (params: any) => {
          armPromptTimeout();
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
          } finally {
            armPromptTimeout();
          }
        });
      }
      if (this.opts.terminal) {
        client.onRequest('terminal/create', async (params: any) => {
          armPromptTimeout();
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
          } finally {
            armPromptTimeout();
          }
        });
        client.onRequest('terminal/output', async (params: any) => {
          armPromptTimeout();
          if (!input.executor) throw new Error('terminal/output: no executor');
          try {
            return await input.executor.terminalOutput({ terminal_id: params?.terminal_id });
          } catch (err) {
            throw mapWriteToolsError(err);
          } finally {
            armPromptTimeout();
          }
        });
        client.onRequest('terminal/wait_for_exit', async (params: any) => {
          armPromptTimeout();
          if (!input.executor) throw new Error('terminal/wait_for_exit: no executor');
          try {
            return await input.executor.terminalWaitForExit({ terminal_id: params?.terminal_id });
          } catch (err) {
            throw mapWriteToolsError(err);
          } finally {
            armPromptTimeout();
          }
        });
        client.onRequest('terminal/release', async (params: any) => {
          armPromptTimeout();
          if (!input.executor) throw new Error('terminal/release: no executor');
          try {
            await input.executor.terminalRelease({ terminal_id: params?.terminal_id });
            return {};
          } catch (err) {
            throw mapWriteToolsError(err);
          } finally {
            armPromptTimeout();
          }
        });
        client.onRequest('terminal/kill', async (params: any) => {
          armPromptTimeout();
          if (!input.executor) throw new Error('terminal/kill: no executor');
          try {
            await input.executor.terminalKill({ terminal_id: params?.terminal_id });
            return {};
          } catch (err) {
            throw mapWriteToolsError(err);
          } finally {
            armPromptTimeout();
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
        this.opts.fsWriteTextFile ||
        this.opts.terminal ||
        (this.opts.mcpServers !== undefined && this.opts.mcpServers.length > 0);
      if (hasClientCapability) {
        client.onRequest('session/request_permission', async (params: any) => {
          armPromptTimeout();
          try {
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
          } finally {
            armPromptTimeout();
          }
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
      // Scope dispatch identity env injection to the penumbra-mcp server only —
      // never leak handoff/tick identifiers to third-party stdio MCPs. We
      // identify it by command/arg path (binary file ending in penumbra-mcp.ts
      // or penumbra-mcp), which is yaml-independent. The agentchat.yaml
      // convention names this server simply `penumbra`, so a name-only check
      // would silently miss it. Some deployments wrap the server in
      // mcp-allowlist-proxy.ts and carry the real upstream command in
      // MCP_PROXY_UPSTREAM; those wrappers should also receive the injected
      // env because the proxy forwards process.env to the upstream child.
      const isPenumbraMcp = (s: any): boolean => {
        if (s.command === undefined) return false;
        const argsArr: string[] = Array.isArray(s.args) ? s.args : [];
        const direct = /penumbra-mcp(\.ts|\.js)?($|[\s/])/.test(
          [s.name ?? '', s.command, ...argsArr].join(' '),
        );
        if (direct) return true;
        const envEntries: Array<{ name?: unknown; value?: unknown }> = Array.isArray(s.env) ? s.env : [];
        const upstream = envEntries.find((entry) => String(entry?.name) === 'MCP_PROXY_UPSTREAM');
        return typeof upstream?.value === 'string' && /penumbra-mcp(\.ts|\.js)?($|[\s/])/.test(upstream.value);
      };
      const longLivedEnv = buildLongLivedMcpEnv(input);
      const shouldInjectDispatchEnv = Boolean(input.handoff_id) || longLivedEnv.length > 0;
      const mcpServersWithEnv = shouldInjectDispatchEnv
        ? mcpServers.map((s: any) =>
            isPenumbraMcp(s)
              ? {
                  ...s,
                  env: [
                    ...((s.env ?? []) as any[]).filter((e: any) => !PENUMBRA_MCP_INJECTED_ENV_KEYS.has(String(e?.name))),
                    ...(input.handoff_id ? [{ name: 'PENUMBRA_HANDOFF_ID', value: input.handoff_id }] : []),
                    ...longLivedEnv,
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
      if (
        this.opts.claudeCodeSettingSources !== undefined ||
        this.opts.claudeCodeStrictMcpConfig !== undefined ||
        this.opts.claudeCodeAllowedTools !== undefined ||
        this.opts.claudeCodeTools !== undefined ||
        this.opts.claudeCodeDisallowedTools !== undefined
      ) {
        sessionParams._meta = {
          ...(sessionParams._meta ?? {}),
          claudeCode: {
            ...(sessionParams._meta?.claudeCode ?? {}),
            options: {
              ...(sessionParams._meta?.claudeCode?.options ?? {}),
              ...(this.opts.claudeCodeSettingSources !== undefined
                ? { settingSources: this.opts.claudeCodeSettingSources }
                : {}),
              ...(this.opts.claudeCodeStrictMcpConfig !== undefined
                ? { strictMcpConfig: this.opts.claudeCodeStrictMcpConfig }
                : {}),
              ...(this.opts.claudeCodeAllowedTools !== undefined
                ? { allowedTools: this.opts.claudeCodeAllowedTools }
                : {}),
              ...(this.opts.claudeCodeTools !== undefined
                ? { tools: this.opts.claudeCodeTools }
                : {}),
              ...(this.opts.claudeCodeDisallowedTools !== undefined
                ? { disallowedTools: this.opts.claudeCodeDisallowedTools }
                : {}),
            },
          },
        };
      }
      const session = await client.request('session/new', sessionParams);
      const sessionId = session.sessionId;
      if (input.handoff_id) {
        registerSession(input.handoff_id, {
          adapter: this.kind,
          inject: async (message) => {
            await client.request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: message.text }],
            });
          },
        });
      }
      emitLifecycle(input, 'acp.session.start', {
        adapter: this.kind,
        session_id: sessionId,
      });

      // 3. Prompt — ACP is streaming-first per @agentclientprotocol/sdk:
      //    - prompt: PromptRequest carries `prompt: Array<ContentBlock>`, not a string
      //    - response: PromptResponse only carries `stopReason` — text is delivered via
      //      `session/update` notifications during the turn (each is a SessionUpdate
      //      whose `sessionUpdate === "agent_message_chunk"` carries a ContentChunk
      //      with `content: TextContent`). Accumulate those.
      let accumulatedText = '';
      const toolNameById = new Map<string, string>();
      let toolUseRejector: ((err: Error) => void) | null = null;
      const toolUseRejection = new Promise<never>((_, reject) => {
        toolUseRejector = reject;
      });
      client.on('session/update', (params: any) => {
        const update = params?.update;
        if (!update || typeof update !== 'object') return;
        armPromptTimeout();
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
              if (input.handoff_id) {
                try {
                  this.deps.thoughtCapture?.recordThought({
                    handoffId: input.handoff_id,
                    adapter: 'stdio-acp',
                    agentName: this.opts.model ?? this.opts.binary,
                    text: content.text,
                    tokenCount: typeof update.token_count === 'number' ? update.token_count : undefined,
                  });
                } catch (err) {
                  console.warn('stdio-acp: failed to capture agent_thought_chunk', err);
                }
              }
            }
            break;
          }
          case 'tool_call': {
            if (typeof update.toolCallId === 'string' && update.toolCallId.length > 0) {
              const toolName =
                (typeof update.title === 'string' && update.title) ||
                (typeof update.kind === 'string' && update.kind) ||
                null;
              if (toolName) toolNameById.set(update.toolCallId, toolName);
            }
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
            // When the adapter advertises a client capability
            // (fsReadTextFile, fsWriteTextFile, terminal, or mcpServers), we
            // must let the turn continue so the agent can actually USE the
            // capability via its RPC path. mcpServers in particular is the
            // typical surface for long-lived agents that operate entirely
            // through MCP tools (e.g., home-mgmt against ha-mcp).
            // Killing here aborts the dispatch before the agent gets that
            // chance.
            //
            // When no client capability is advertised, the adapter is in
            // single-turn echo mode — preserve the original kill-on-tool-call
            // behavior to surface the limitation clearly rather than letting
            // the agent run a multi-turn tool loop with no client support.
            const clientCapability = supportsClientCapability(this.opts);
            if (!clientCapability) {
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
            const resolvedToolName =
              (typeof update.title === 'string' && update.title) ||
              (typeof update.kind === 'string' && update.kind) ||
              (typeof update.toolCallId === 'string' ? toolNameById.get(update.toolCallId) : undefined) ||
              null;
            const hasStructuredFailure = update.output !== null && update.output !== undefined && update.output !== '';
            // Terminal-create failures with null output are codex-acp lifecycle teardown noise; agent-level recovery
            // is the actual signal we measure downstream.
            if (update.status === 'failed' && (hasStructuredFailure || !looksLikeShellCommand(resolvedToolName))) {
              emitLifecycle(input, 'agent.tool_call.failed', {
                adapter: this.kind,
                tool_call_id: update.toolCallId,
                tool_name: resolvedToolName,
                output: update.output ?? null,
              });
            }
            // tool_call SessionUpdates are agent-side observability for the
            // agent's own internal tools (its built-in Read/Bash/etc.). They
            // are NOT requests for the client to execute work — those go via
            // JSON-RPC requests like fs/read_text_file (handled by onRequest).
            //
            // When the adapter advertises a client capability
            // (fsReadTextFile, fsWriteTextFile, terminal, or mcpServers), we
            // must let the turn continue so the agent can actually USE the
            // capability via its RPC path. mcpServers in particular is the
            // typical surface for long-lived agents that operate entirely
            // through MCP tools (e.g., home-mgmt against ha-mcp).
            // Killing here aborts the dispatch before the agent gets that
            // chance.
            //
            // When no client capability is advertised, the adapter is in
            // single-turn echo mode — preserve the original kill-on-tool-call
            // behavior to surface the limitation clearly rather than letting
            // the agent run a multi-turn tool loop with no client support.
            const clientCapability = supportsClientCapability(this.opts);
            if (!clientCapability) {
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

      const promptTimeoutPromise = new Promise<never>((_, reject) => {
        promptTimeoutRejector = reject;
        armPromptTimeout();
      });

      try {
        // PromptResponse carries stopReason; the actual text lives in accumulatedText.
        const promptResponse = await Promise.race([promptPromise, toolUseRejection, promptTimeoutPromise]);
        emitLifecycle(input, 'acp.session.end', {
          adapter: this.kind,
          session_id: sessionId,
          stop_reason: (promptResponse as any)?.stopReason ?? null,
        });
      } finally {
        promptTimeoutRejector = null;
        clearPromptTimeout();
      }

      yield {
        type: 'done',
        result: {
          text: accumulatedText,
        },
      };
    } catch (err) {
      // Augment any failure thrown from the dispatch turn with the captured
      // child stderr tail. This covers session/new failures, capability
      // negotiation hangs, and abnormal exits — all paths where the upstream
      // CLI's diagnostic output (auth errors, plan limits, missing env vars)
      // is the most useful evidence and would otherwise be lost in the
      // shared worker stderr log.
      if (server && err instanceof Error && !err.message.includes('[child stderr tail]')) {
        const tail = server.getStderrTail?.() ?? '';
        if (tail) err.message = `${err.message}\n[child stderr tail]\n${tail}`;
      }
      throw err;
    } finally {
      if (input.handoff_id) {
        unregisterSession(input.handoff_id);
      }
      if (server) {
        server.kill();
      }
    }
  }
}
