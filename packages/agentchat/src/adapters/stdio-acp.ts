import type { DispatchEventInput } from "@penumbra/core";

import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import type { CapturePort } from "../worker/capture-port.js";
import type { McpServer } from "./acp-types.js";

import { type ClassifierDeclineMeta, detectClassifierDecline } from "../classifier-decline.js";
import { registerSession, unregisterSession } from "../worker/session-registry.js";
import { executeReadTextFile, ReadTextFileError } from "./acp-fs.js";
import {
  acpSpecHash,
  type AcpWarmPool,
  type AcpWarmPoolEntry,
  poolKeyFor,
} from "./acp-warm-pool.js";
import { StdioAcpClient } from "./stdio-acp-client.js";
import {
  startStdioAcpServer,
  type StartStdioAcpServerOptions,
  type StdioAcpHandle,
} from "./stdio-acp-server.js";

export function detectStdioAcpClassifierDecline(input: {
  finalText: string | null | undefined;
  errorText: string | null | undefined;
}): ClassifierDeclineMeta | null {
  return detectClassifierDecline(input);
}

// File-local typed bridge for ACP handler registrations. StdioAcpClient.on /
// onRequest accept the wire-shape `(params: unknown) => ...` so that test mocks
// (which mirror that concrete signature) can be assigned via
// `StdioAcpClient["on"|"onRequest"]`. Handlers in this module are written
// against typed wire shapes (AcpFooParams) for readability; the helpers below
// erase the typed param to `unknown` at the storage boundary while preserving
// the param-type at the wrapping callsite for documentation. The phantom
// `__params` marker uses T twice in each helper signature so no-unnecessary-
// type-parameters does not flag the erasure.
type TypedRequestFn<T> = ((params: unknown) => unknown) & {
  readonly __params?: T;
};
type TypedNotifyFn<T> = ((params: unknown) => void) & { readonly __params?: T };

function typedRequest<T>(fn: (params: T) => unknown): TypedRequestFn<T> {
  return fn as unknown as TypedRequestFn<T>;
}

function typedNotify<T>(fn: (params: T) => void): TypedNotifyFn<T> {
  return fn as unknown as TypedNotifyFn<T>;
}

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

interface ErrorWithCode extends Error {
  code?: unknown;
}

interface MappedError extends Error {
  code?: number;
}

function mapWriteToolsError(err: unknown): Error {
  if (err instanceof Error && "code" in err) {
    const errCode = (err as ErrorWithCode).code;
    if (typeof errCode === "string") {
      const code = ERROR_CODE_MAP[errCode] ?? -32099;
      const mapped: MappedError = new Error(err.message);
      mapped.code = code;
      return mapped;
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

// Idle / no-wire-activity stall timeout for stdio-acp dispatches. Raised from 5min
// to 20min (2026-06-14): 5min was too tight for substantial reasoning/tool turns —
// a single long LLM turn or a multi-minute test/typecheck run emits no wire activity
// (session/update or onRequest) for minutes, tripping a false "agent stalled mid-turn"
// kill on large multi-file tasks (observed killing both sonnet-acp and opus-acp on the
// usage-steering Phase-4 build). A genuinely hung agent is still caught within 20min.
// Per-seat `requestTimeoutMs` (agentchat options, schema-capped at 900_000) overrides this.
const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000;
const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
// Upper bound for the optional model-warmup prompt (modelWarmupPrompt). The
// `/model` acknowledgment turn is fast (~5-10s observed), but a cold model load
// can be slower; cap at 2min and fall through to the real task prompt regardless
// so warmup is never able to wedge a dispatch.
const MODEL_WARMUP_TIMEOUT_MS = 120_000;
const LONG_LIVED_SELF_TOOL_NAMES = [
  "long_lived_self_state_get",
  "long_lived_self_state_set",
  "long_lived_self_pending_actions",
] as const;
const CLAUDE_HOST_ENV_LITERAL_KEYS = new Set(["CLAUDECODE", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA"]);

export type HostEnvProvider = "claude";

export type HostEnvPolicy = Partial<Record<HostEnvProvider, boolean>>;

type HostEnvPredicate = (key: string) => boolean;

export const HOST_ENV_PREDICATES: Record<HostEnvProvider, HostEnvPredicate> = {
  claude: (key) => key.startsWith("CLAUDE_CODE_") || CLAUDE_HOST_ENV_LITERAL_KEYS.has(key),
};

export function isClaudeHostEnvKey(key: string): boolean {
  return HOST_ENV_PREDICATES.claude(key);
}

export function resolveHostEnvPolicy(
  opts: Pick<StdioAcpOptions, "hostEnvPolicy"> & { sanitizeClaudeHostEnv?: boolean },
): HostEnvPolicy {
  const policy: HostEnvPolicy = { ...(opts.hostEnvPolicy ?? {}) };
  if (opts.sanitizeClaudeHostEnv === true && policy.claude === undefined) {
    policy.claude = true;
  }
  for (const [key, enabled] of Object.entries(policy)) {
    if (!enabled) continue;
    if (!(key in HOST_ENV_PREDICATES)) {
      throw new Error(
        `stdio-acp: hostEnvPolicy has unknown provider "${key}" set to true. Known providers: ${Object.keys(HOST_ENV_PREDICATES).join(", ")}.`,
      );
    }
  }
  return policy;
}

export function shouldScrubHostEnvKey(key: string, policy: HostEnvPolicy): boolean {
  for (const provider of Object.keys(policy) as HostEnvProvider[]) {
    if (!policy[provider]) continue;
    const predicate = HOST_ENV_PREDICATES[provider] as HostEnvPredicate | undefined;
    if (predicate?.(key) === true) return true;
  }
  return false;
}
const PENUMBRA_MCP_INJECTED_ENV_KEYS = new Set([
  "PENUMBRA_HANDOFF_ID",
  // Per-worktree storage root. resolveDaemonStorageRoot returns
  // env.PENUMBRA_STORAGE_ROOT first, so a warm-reused process (whose process env
  // is frozen at the FIRST dispatch's worktree) must have the current dispatch's
  // value re-injected per session/new — else the MCP child reads the wrong
  // worktree's DB. Stripped here so a stale value can't survive the re-inject.
  "PENUMBRA_STORAGE_ROOT",
  "PENUMBRA_MCP_ORIGIN",
  "PENUMBRA_LONG_LIVED_AGENT_ID",
  "PENUMBRA_LONG_LIVED_TICK_ID",
  // Note: PENUMBRA_MCP_TOOL_ALLOWLIST is intentionally NOT in this strip-list.
  // For long_lived_tick dispatches the adapter STILL appends its own value
  // after the user-provided one (last-wins on env merge), so dispatch-side
  // injection is unaffected. But for manual chain_start tests (and any
  // non-long-lived dispatch path), the user's yaml-level allowlist now
  // passes through — without this, the schema-injection bloat fix has no
  // way to land outside the cron tick path.
]);
const PENUMBRA_MCP_ORIGIN_FLEET_WORKER = "fleet-worker";

export class AcpSessionEvictedError extends Error {
  readonly retryable = true;

  constructor(message = "stdio-acp: warm ACP session was evicted mid-turn") {
    super(message);
    this.name = "AcpSessionEvictedError";
  }
}

interface EnvEntry {
  name: string;
  value: string;
}

function buildLongLivedMcpEnv(input: DispatchInput): EnvEntry[] {
  const session = input.long_lived_session;
  if (session?.dispatch_kind !== "long_lived_tick") return [];

  const stripPenumbraPrefix = (name: string): string =>
    name.startsWith("penumbra:") ? name.slice("penumbra:".length) : name;
  const allowlist = new Set(
    (session.mcp_tool_allowlist ?? [])
      .map((name) => name.trim())
      .map(stripPenumbraPrefix)
      .filter((name) => name.length > 0),
  );
  for (const toolName of LONG_LIVED_SELF_TOOL_NAMES) {
    allowlist.add(toolName);
  }

  const envEntries: EnvEntry[] = [
    { name: "PENUMBRA_MCP_TOOL_ALLOWLIST", value: [...allowlist].join(",") },
  ];
  if (session.agent_id !== null && session.agent_id !== undefined && session.agent_id.length > 0) {
    envEntries.push({ name: "PENUMBRA_LONG_LIVED_AGENT_ID", value: session.agent_id });
  }
  if (session.tick_id !== null && session.tick_id !== undefined && session.tick_id.length > 0) {
    envEntries.push({ name: "PENUMBRA_LONG_LIVED_TICK_ID", value: session.tick_id });
  }
  return envEntries;
}

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

function supportsClientCapability(
  opts: Pick<StdioAcpOptions, "fsReadTextFile" | "fsWriteTextFile" | "terminal" | "mcpServers">,
): boolean {
  return (
    opts.fsReadTextFile === true ||
    opts.fsWriteTextFile === true ||
    opts.terminal === true ||
    (opts.mcpServers !== undefined && opts.mcpServers.length > 0)
  );
}

export interface StdioAcpOptions {
  binary: string;
  args?: string[];
  agentName?: string;
  model?: string;
  cwd?: string;
  /**
   * Repository root shared across this agent's per-dispatch worktrees. The warm
   * pool keys on (agent, repoRoot) rather than (agent, cwd): a warm ACP process
   * is reused across worktrees of the same repo and issued a fresh session/new
   * at each dispatch's cwd. Set per-dispatch by the worktree override; falls
   * back to cwd when absent (so non-worktree dispatches keep per-cwd pooling).
   */
  repoRoot?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  bootTimeoutMs?: number;
  requestTimeoutMs?: number;
  authMethodId?: string;
  framing?: "newline" | "content-length";
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
  claudeCodeSettingSources?: ("user" | "project" | "local")[];
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
   * Deprecated: prefer `hostEnvPolicy: { claude: true }`. Preserved as a
   * one-tick alias for yaml backwards-compat; resolved into hostEnvPolicy when
   * hostEnvPolicy is unset.
   */
  sanitizeClaudeHostEnv?: boolean;
  warmPool?: boolean;
  warmPoolIdleGraceMs?: number;
  warmPoolMaxAgeMs?: number;
  warmPoolMaxEntries?: number;
  warmPoolSize?: number;
  /**
   * When set (non-empty), a fresh (non-reused) claude-agent-acp process is sent
   * this throwaway prompt ONCE, before the real task, to absorb the per-process
   * `/model` handshake that an `ANTHROPIC_MODEL` env pin triggers.
   *
   * claude-agent-acp injects a `/model <ANTHROPIC_MODEL>` slash command on the
   * first prompt a fresh process handles and ends THAT turn with `end_turn`
   * WITHOUT running the task — so the first dispatch on every cold process (and
   * the first dispatch on each warm-pool process) was recorded as
   * `no_worktree_activity` even though the seat was healthy. The warmup prompt
   * takes that hit so the real task prompt runs on a model-settled session.
   * Skipped on warm-connection reuse (the process already absorbed `/model`).
   */
  modelWarmupPrompt?: string;
}

export interface StdioAcpThoughtCapture {
  recordThought: (input: {
    handoffId: string;
    adapter: "stdio-acp";
    agentName: string;
    text: string;
    tokenCount?: number;
    ts?: string;
  }) => void;
}

interface StdioAcpAdapterDeps {
  startServer: (opts: StartStdioAcpServerOptions) => Promise<StdioAcpHandle>;
  createClient: (handle: StdioAcpHandle) => StdioAcpClient;
  pool?: AcpWarmPool;
  thoughtCapture?: StdioAcpThoughtCapture;
}

interface StdioAcpBootDeadline {
  expiresAt: number;
  timeoutMs: number;
}

// ACP wire-protocol shapes the adapter touches. These mirror the
// @agentclientprotocol/sdk schema; we re-declare here rather than depend on the
// SDK's runtime types so the StdioAcpClient `any`-typed boundary can be
// narrowed at the adapter surface without inline `as` casts at each access.
interface AcpClientFsCapability {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

interface AcpClientCapabilities {
  fs?: AcpClientFsCapability;
  terminal?: boolean;
}

interface AcpAuthMethodVar {
  name: string;
}

interface AcpAuthMethod {
  id: string;
  type?: string;
  vars?: AcpAuthMethodVar[];
}

interface AcpInitializeResponse {
  authMethods?: AcpAuthMethod[];
}

interface AcpSessionNewResponse {
  sessionId: string;
}

interface AcpPromptResponse {
  stopReason?: string | null;
}

interface AcpReadTextFileParams {
  path?: string;
  line?: number;
  limit?: number;
}

interface AcpWriteTextFileParams {
  path?: string;
  content?: string;
}

interface AcpTerminalCreateParams {
  command?: string;
  args?: string[];
  cwd?: string;
  output_byte_limit?: number;
}

interface AcpTerminalIdParams {
  terminal_id?: string;
}

interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
}

interface AcpPermissionToolCall {
  title?: string;
  name?: string;
  rawInput?: unknown;
}

interface AcpRequestPermissionParams {
  options?: AcpPermissionOption[];
  toolCall?: AcpPermissionToolCall;
}

interface AcpTextContent {
  type?: string;
  text?: string;
}

interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: AcpTextContent;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  used?: number;
  size?: number;
  cost?: unknown;
  token_count?: number;
}

interface AcpSessionUpdateParams {
  update?: AcpSessionUpdate;
}

interface ClaudeCodeOptions {
  settingSources?: ("user" | "project" | "local")[];
  strictMcpConfig?: boolean;
  allowedTools?: string[];
  tools?: string[];
  disallowedTools?: string[];
}

interface ClaudeCodeMeta {
  options?: ClaudeCodeOptions;
}

interface SessionParamsMeta {
  claudeCode?: ClaudeCodeMeta;
}

interface SessionNewParams {
  cwd: string;
  mcpServers: McpServer[];
  model?: string;
  _meta?: SessionParamsMeta;
}

interface SessionPromptMetaPenumbra {
  handoff_id?: string;
}

interface SessionPromptMeta {
  penumbraHandoffId?: string;
  penumbra?: SessionPromptMetaPenumbra;
}

interface SessionPromptParams {
  sessionId: string;
  prompt: { type: "text"; text: string }[];
  _meta?: SessionPromptMeta;
}

interface McpServerEnvEntry {
  name?: unknown;
  value?: unknown;
}

interface McpServerWithEnv {
  command?: string;
  name?: string;
  args?: string[];
  env?: McpServerEnvEntry[];
}

function isPenumbraMcp(server: McpServer): boolean {
  const candidate = server as McpServerWithEnv;
  if (candidate.command === undefined) return false;
  const argsArr: string[] = Array.isArray(candidate.args) ? candidate.args : [];
  const direct = /penumbra-mcp(?:\.ts|\.js)?(?:$|[\s/])/.test(
    [candidate.name ?? "", candidate.command, ...argsArr].join(" "),
  );
  if (direct) return true;
  const envEntries: McpServerEnvEntry[] = Array.isArray(candidate.env) ? candidate.env : [];
  const upstream = envEntries.find((entry) => String(entry.name) === "MCP_PROXY_UPSTREAM");
  return (
    typeof upstream?.value === "string" &&
    /penumbra-mcp(?:\.ts|\.js)?(?:$|[\s/])/.test(upstream.value)
  );
}

function buildMcpServersWithEnv(
  mcpServers: McpServer[],
  input: DispatchInput,
  mergedEnv: Record<string, string>,
): McpServer[] {
  const longLivedEnv = buildLongLivedMcpEnv(input);
  const storageRootEnv: EnvEntry[] =
    mergedEnv.PENUMBRA_STORAGE_ROOT !== undefined
      ? [{ name: "PENUMBRA_STORAGE_ROOT", value: mergedEnv.PENUMBRA_STORAGE_ROOT }]
      : [];
  const shouldInjectDispatchEnv =
    input.handoff_id !== undefined || longLivedEnv.length > 0 || storageRootEnv.length > 0;
  if (!shouldInjectDispatchEnv) return mcpServers;

  return mcpServers.map((server): McpServer => {
    if (!isPenumbraMcp(server)) return server;
    const candidate = server as McpServerWithEnv;
    const existingEnv = candidate.env ?? [];
    const filtered = existingEnv.filter(
      (entry) => !PENUMBRA_MCP_INJECTED_ENV_KEYS.has(String(entry.name)),
    );
    const handoffEnv: EnvEntry[] =
      input.handoff_id !== undefined
        ? [{ name: "PENUMBRA_HANDOFF_ID", value: input.handoff_id }]
        : [];
    const nextEnv: McpServerEnvEntry[] = [
      ...filtered,
      ...handoffEnv,
      { name: "PENUMBRA_MCP_ORIGIN", value: PENUMBRA_MCP_ORIGIN_FLEET_WORKER },
      ...storageRootEnv,
      ...longLivedEnv,
    ];
    return { ...server, env: nextEnv } as McpServer;
  });
}

function buildClaudeCodeMeta(opts: StdioAcpOptions): SessionParamsMeta | undefined {
  const has =
    opts.claudeCodeSettingSources !== undefined ||
    opts.claudeCodeStrictMcpConfig !== undefined ||
    opts.claudeCodeAllowedTools !== undefined ||
    opts.claudeCodeTools !== undefined ||
    opts.claudeCodeDisallowedTools !== undefined;
  if (!has) return undefined;
  const options: ClaudeCodeOptions = {};
  if (opts.claudeCodeSettingSources !== undefined) {
    options.settingSources = opts.claudeCodeSettingSources;
  }
  if (opts.claudeCodeStrictMcpConfig !== undefined) {
    options.strictMcpConfig = opts.claudeCodeStrictMcpConfig;
  }
  if (opts.claudeCodeAllowedTools !== undefined) {
    options.allowedTools = opts.claudeCodeAllowedTools;
  }
  if (opts.claudeCodeTools !== undefined) {
    options.tools = opts.claudeCodeTools;
  }
  if (opts.claudeCodeDisallowedTools !== undefined) {
    options.disallowedTools = opts.claudeCodeDisallowedTools;
  }
  return { claudeCode: { options } };
}

function selectAuthMethodId(
  authMethods: AcpAuthMethod[],
  configured: string | undefined,
  mergedEnv: Record<string, string>,
): string {
  if (configured !== undefined) return configured;
  const satisfiedEnvVar = authMethods.find(
    (m) => m.type === "env_var" && (m.vars ?? []).every((v) => mergedEnv[v.name] !== undefined),
  );
  if (satisfiedEnvVar) return satisfiedEnvVar.id;
  const nonEnvVar = authMethods.find((m) => m.type !== "env_var");
  const fallback = nonEnvVar ?? authMethods[0];
  if (!fallback) throw new Error("stdio-acp: selectAuthMethodId called with no methods");
  return fallback.id;
}

interface DispatchTurnContext {
  cwd: string;
  client: StdioAcpClient;
  input: DispatchInput;
  getServer: () => StdioAcpHandle | null;
  toolUseRejectorRef: { current: ((err: Error) => void) | null };
  capability: boolean;
  thoughtCapture?: StdioAcpThoughtCapture;
  capturePort?: CapturePort;
  modelLabel: string;
  arm: () => void;
  markUpdate: () => void;
  accumulate: (text: string) => void;
  toolNames: Map<string, string>;
}

function registerFsHandlers(ctx: DispatchTurnContext, opts: StdioAcpOptions): void {
  if (opts.fsReadTextFile === true) {
    ctx.client.onRequest(
      "fs/read_text_file",
      typedRequest<AcpReadTextFileParams>(async (params) => {
        ctx.arm();
        if (typeof params.path !== "string") throw new Error("fs/read_text_file: missing path");
        try {
          return await executeReadTextFile(
            { path: params.path, line: params.line, limit: params.limit },
            ctx.cwd,
          );
        } catch (err) {
          if (err instanceof ReadTextFileError) {
            // Format the error message so client-side string-matchers
            // recognise file-not-found correctly. Gemini-cli's
            // AcpFileSystemService.normalizeFileSystemError checks for
            // 'ENOENT' / 'No such file' / 'Resource not found' / 'does not exist'.
            if (err.code === "not_found") {
              throw new Error(`ENOENT: No such file or directory: ${err.message}`);
            }
            throw new Error(`fs/read_text_file ${err.code}: ${err.message}`);
          }
          throw err;
        } finally {
          ctx.arm();
        }
      }),
    );
  }
  if (opts.fsWriteTextFile === true) {
    ctx.client.onRequest(
      "fs/write_text_file",
      typedRequest<AcpWriteTextFileParams>(async (params) => {
        ctx.arm();
        if (!ctx.input.executor)
          throw new Error("fs/write_text_file: no executor in dispatch input");
        if (typeof params.path !== "string") throw new Error("fs/write_text_file: missing path");
        try {
          await ctx.input.executor.writeTextFile(
            { path: params.path, content: params.content },
            {
              toolName: "fs.write_text_file",
              rawInput: {
                path: params.path,
                content_bytes:
                  typeof params.content === "string"
                    ? Buffer.byteLength(params.content, "utf8")
                    : 0,
              },
              dispatchId: ctx.input.handoff_id ?? "unknown",
            },
          );
          return {};
        } catch (err) {
          throw mapWriteToolsError(err);
        } finally {
          ctx.arm();
        }
      }),
    );
  }
}

function registerTerminalHandlers(ctx: DispatchTurnContext, opts: StdioAcpOptions): void {
  if (opts.terminal !== true) return;
  const { client, input, arm } = ctx;
  client.onRequest(
    "terminal/create",
    typedRequest<AcpTerminalCreateParams>(async (params) => {
      arm();
      if (!input.executor) throw new Error("terminal/create: no executor");
      try {
        return await input.executor.terminalCreate(
          {
            command: params.command,
            argv: params.args,
            cwd: params.cwd,
            output_byte_limit: params.output_byte_limit,
          },
          {
            toolName: "terminal.create",
            rawInput: {
              argv: params.args ?? null,
              cmd: params.command ?? null,
              cwd: params.cwd ?? ".",
            },
            dispatchId: input.handoff_id ?? "unknown",
          },
        );
      } catch (err) {
        throw mapWriteToolsError(err);
      } finally {
        arm();
      }
    }),
  );
  type TerminalExecutor = NonNullable<DispatchInput["executor"]>;
  const wrapTerminalCommand = (
    method: string,
    fn: (executor: TerminalExecutor, terminalId: string) => Promise<unknown>,
  ): void => {
    client.onRequest(
      method,
      typedRequest<AcpTerminalIdParams>(async (params) => {
        arm();
        const executor = input.executor;
        if (!executor) throw new Error(`${method}: no executor`);
        try {
          return await fn(executor, params.terminal_id ?? "");
        } catch (err) {
          throw mapWriteToolsError(err);
        } finally {
          arm();
        }
      }),
    );
  };
  wrapTerminalCommand(
    "terminal/output",
    async (executor, terminalId) => await executor.terminalOutput({ terminal_id: terminalId }),
  );
  wrapTerminalCommand(
    "terminal/wait_for_exit",
    async (executor, terminalId) => await executor.terminalWaitForExit({ terminal_id: terminalId }),
  );
  wrapTerminalCommand("terminal/release", async (executor, terminalId) => {
    await executor.terminalRelease({ terminal_id: terminalId });
    return {};
  });
  wrapTerminalCommand("terminal/kill", async (executor, terminalId) => {
    await executor.terminalKill({ terminal_id: terminalId });
    return {};
  });
}

type PermissionOptionPredicate = (o: AcpPermissionOption) => boolean;

function pickPermissionOption(
  options: AcpPermissionOption[],
  predicates: PermissionOptionPredicate[],
): AcpPermissionOption | undefined {
  for (const predicate of predicates) {
    const found = options.find((o) => predicate(o));
    if (found) return found;
  }
  return undefined;
}

interface PermissionResultCancelled {
  outcome: { outcome: "cancelled" };
}
interface PermissionResultSelected {
  outcome: { outcome: "selected"; optionId: string };
}
type PermissionResult = PermissionResultCancelled | PermissionResultSelected;

function cancelledOutcome(): PermissionResultCancelled {
  return { outcome: { outcome: "cancelled" } };
}

async function handlePermissionRequest(
  ctx: DispatchTurnContext,
  params: AcpRequestPermissionParams,
): Promise<PermissionResult> {
  const options = Array.isArray(params.options) ? params.options : [];
  if (!ctx.input.requestPermission) {
    const chosen = pickPermissionOption(options, [
      (o: AcpPermissionOption): boolean => o.kind === "allow_always",
      (o: AcpPermissionOption): boolean => o.kind === "allow_once",
      (): boolean => true,
    ]);
    if (chosen?.optionId === undefined) return cancelledOutcome();
    return { outcome: { outcome: "selected", optionId: chosen.optionId } };
  }
  const allowOption = pickPermissionOption(options, [
    (o: AcpPermissionOption): boolean => o.kind === "allow_always",
    (o: AcpPermissionOption): boolean => o.kind === "allow_once",
    (o: AcpPermissionOption): boolean => o.optionId !== undefined,
  ]);
  const rejectOption = pickPermissionOption(options, [
    (o: AcpPermissionOption): boolean => o.kind === "reject_always",
    (o: AcpPermissionOption): boolean => o.kind === "reject_once",
  ]);
  const toolName: string | null =
    (typeof params.toolCall?.title === "string" && params.toolCall.title) ||
    (typeof params.toolCall?.name === "string" && params.toolCall.name) ||
    null;
  if (toolName === null) return cancelledOutcome();
  let decision: "approve" | "reject" = "approve";
  try {
    decision = await ctx.input.requestPermission({
      toolName,
      rawInput: params.toolCall?.rawInput ?? params.toolCall ?? null,
      dispatchId: ctx.input.handoff_id ?? ctx.input.conversation.id,
    });
  } catch {
    decision = "reject";
  }
  if (decision === "approve" && allowOption?.optionId !== undefined) {
    return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
  }
  if (decision === "reject" && rejectOption?.optionId !== undefined) {
    return { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
  }
  return cancelledOutcome();
}

function registerPermissionHandler(ctx: DispatchTurnContext, opts: StdioAcpOptions): void {
  if (!supportsClientCapability(opts)) return;
  ctx.client.onRequest(
    "session/request_permission",
    typedRequest<AcpRequestPermissionParams>(async (params) => {
      ctx.arm();
      try {
        return await handlePermissionRequest(ctx, params);
      } finally {
        ctx.arm();
      }
    }),
  );
}

function resolveToolName(update: AcpSessionUpdate, toolNames: Map<string, string>): string | null {
  if (typeof update.title === "string" && update.title.length > 0) return update.title;
  if (typeof update.kind === "string" && update.kind.length > 0) return update.kind;
  if (typeof update.toolCallId === "string") {
    return toolNames.get(update.toolCallId) ?? null;
  }
  return null;
}

function handleAgentMessageChunk(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  const content = update.content;
  if (content?.type !== "text" || typeof content.text !== "string") return;
  ctx.accumulate(content.text);
  ctx.capturePort?.emit({ kind: "agent_message_chunk", content: content.text });
}

function handleAgentThoughtChunk(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  const content = update.content;
  if (content?.type !== "text" || typeof content.text !== "string") return;
  ctx.capturePort?.emit({ kind: "agent_thought_chunk", content: content.text });
  if (ctx.input.handoff_id === undefined) return;
  try {
    ctx.thoughtCapture?.recordThought({
      handoffId: ctx.input.handoff_id,
      adapter: "stdio-acp",
      agentName: ctx.modelLabel,
      text: content.text,
      tokenCount: typeof update.token_count === "number" ? update.token_count : undefined,
    });
  } catch (err) {
    console.warn("stdio-acp: failed to capture agent_thought_chunk", err);
  }
}

function killOnToolCallWhenNoCapability(ctx: DispatchTurnContext): void {
  if (ctx.capability) return;
  ctx.getServer()?.kill();
  ctx.toolUseRejectorRef.current?.(
    new Error("stdio-acp: tool use not yet supported in this adapter phase"),
  );
}

type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "canceled";
const TOOL_CALL_STATUSES: readonly ToolCallStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "canceled",
];

function narrowToolCallStatus(status: unknown): ToolCallStatus | undefined {
  if (typeof status !== "string") return undefined;
  return TOOL_CALL_STATUSES.find((s) => s === status);
}

function handleToolCall(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  if (typeof update.toolCallId === "string" && update.toolCallId.length > 0) {
    const toolName =
      (typeof update.title === "string" && update.title) ||
      (typeof update.kind === "string" && update.kind) ||
      null;
    if (toolName !== null) ctx.toolNames.set(update.toolCallId, toolName);
  }
  ctx.capturePort?.emit({
    kind: "tool_call",
    toolCallId: update.toolCallId,
    status: narrowToolCallStatus(update.status),
    input: update.input,
  });
  killOnToolCallWhenNoCapability(ctx);
}

function handleToolCallUpdate(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  ctx.capturePort?.emit({
    kind: "tool_call_update",
    toolCallId: update.toolCallId,
    status: narrowToolCallStatus(update.status),
    output: update.output,
  });
  if (update.status === "failed") {
    emitLifecycle(ctx.input, "agent.tool_call.failed", {
      adapter: "stdio-acp",
      tool_call_id: update.toolCallId,
      tool_name: resolveToolName(update, ctx.toolNames),
      output: update.output ?? null,
    });
  }
  killOnToolCallWhenNoCapability(ctx);
}

function narrowUsageCost(cost: unknown): { amount: number; currency: string } | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const obj = cost as { amount?: unknown; currency?: unknown };
  if (typeof obj.amount !== "number" || typeof obj.currency !== "string") return undefined;
  return { amount: obj.amount, currency: obj.currency };
}

function handleUsageUpdate(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  const used = typeof update.used === "number" ? update.used : Number.NaN;
  const size = typeof update.size === "number" ? update.size : Number.NaN;
  if (!Number.isFinite(used) || !Number.isFinite(size)) return;
  ctx.capturePort?.emit({
    kind: "usage_update",
    used,
    size,
    cost: narrowUsageCost(update.cost),
  });
}

function dispatchSessionUpdate(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      handleAgentMessageChunk(ctx, update);
      break;
    case "agent_thought_chunk":
      handleAgentThoughtChunk(ctx, update);
      break;
    case "tool_call":
      handleToolCall(ctx, update);
      break;
    case "tool_call_update":
      handleToolCallUpdate(ctx, update);
      break;
    case "usage_update":
      handleUsageUpdate(ctx, update);
      break;
    default:
      break;
  }
}

interface AcquireOrSpawnResult {
  server: StdioAcpHandle;
  client: StdioAcpClient;
  pooledEntry: AcpWarmPoolEntry | null;
  reusedSession: boolean;
}

export class StdioAcpAdapter implements Adapter {
  readonly kind = "stdio-acp";

  constructor(
    private readonly opts: StdioAcpOptions,
    private readonly deps: StdioAcpAdapterDeps = {
      startServer: startStdioAcpServer,
      createClient: (h: StdioAcpHandle): StdioAcpClient =>
        new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout, framing: opts.framing }),
    },
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    let result: DispatchOutput | null = null;
    for await (const event of this.dispatchStream(input)) {
      if (event.type === "done") {
        result = event.result;
      }
    }
    if (!result) throw new Error("stdio-acp: stream ended without result");
    return result;
  }

  /**
   * Build the dispatch-time process env: inherited env (host-scrubbed) merged
   * with opts.env, minus unsetEnv.
   */
  private buildMergedEnv(): Record<string, string> {
    const hostEnvPolicy = resolveHostEnvPolicy(this.opts);
    const hasScrubPolicy = Object.values(hostEnvPolicy).some(Boolean);
    const inheritedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (hasScrubPolicy && shouldScrubHostEnvKey(key, hostEnvPolicy)) continue;
      inheritedEnv[key] = value;
    }
    const unsetEnv = new Set(this.opts.unsetEnv ?? []);
    const overlay = this.opts.env ?? {};
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(inheritedEnv)) {
      if (unsetEnv.has(key)) continue;
      mergedEnv[key] = value;
    }
    for (const [key, value] of Object.entries(overlay)) {
      if (unsetEnv.has(key)) continue;
      mergedEnv[key] = value;
    }
    return mergedEnv;
  }

  private async spawnAcpServer(
    cwd: string,
    mergedEnv: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<{ server: StdioAcpHandle; client: StdioAcpClient }> {
    const server = await this.deps.startServer({
      binary: this.opts.binary,
      args: this.opts.args,
      cwd,
      env: mergedEnv,
      signal,
    });
    const client = this.deps.createClient(server);
    return { server, client };
  }

  private createBootDeadline(): StdioAcpBootDeadline {
    const timeoutMs = this.opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    return {
      expiresAt: Date.now() + timeoutMs,
      timeoutMs,
    };
  }

  private async requestWithBootDeadline<T>(
    server: StdioAcpHandle,
    client: StdioAcpClient,
    deadline: StdioAcpBootDeadline,
    method: string,
    params?: unknown,
  ): Promise<T> {
    const remainingMs = deadline.expiresAt - Date.now();
    if (remainingMs <= 0) {
      server.kill();
      throw new Error(
        `stdio-acp: boot timed out after ${String(deadline.timeoutMs)}ms while waiting for ${method}`,
      );
    }

    const timeoutHolder: { ref: ReturnType<typeof setTimeout> | null } = { ref: null };
    try {
      return await Promise.race([
        client.request(method, params) as Promise<T>,
        new Promise<never>((_, reject) => {
          timeoutHolder.ref = setTimeout(() => {
            server.kill();
            reject(
              new Error(
                `stdio-acp: boot timed out after ${String(deadline.timeoutMs)}ms while waiting for ${method}`,
              ),
            );
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeoutHolder.ref !== null) clearTimeout(timeoutHolder.ref);
    }
  }

  private buildClientCapabilities(): AcpClientCapabilities {
    const capabilities: AcpClientCapabilities = {};
    const fs: AcpClientFsCapability = {};
    if (this.opts.fsReadTextFile === true) fs.readTextFile = true;
    if (this.opts.fsWriteTextFile === true) fs.writeTextFile = true;
    if (fs.readTextFile === true || fs.writeTextFile === true) capabilities.fs = fs;
    if (this.opts.terminal === true) capabilities.terminal = true;
    return capabilities;
  }

  private maybeDepositWarm(args: {
    server: StdioAcpHandle;
    client: StdioAcpClient;
    warmPoolEnabled: boolean;
    poolKey: string;
    specHash: string;
  }): AcpWarmPoolEntry | null {
    if (!args.warmPoolEnabled || !this.deps.pool) return null;
    return (
      this.deps.pool.deposit(args.poolKey, {
        handle: args.server,
        client: args.client,
        specHash: args.specHash,
      }) ?? null
    );
  }

  /**
   * Initialize + authenticate the connection, then deposit the warm connection
   * into the pool (when enabled). Returns the deposited entry, or null when the
   * pool is disabled. Issues NO session/new. Shared by the cold dispatch path
   * and prewarm so both produce a byte-identical warm connection.
   */
  private async handshakeAndDeposit(
    server: StdioAcpHandle,
    client: StdioAcpClient,
    args: {
      mergedEnv: Record<string, string>;
      specHash: string;
      poolKey: string;
      warmPoolEnabled: boolean;
      pinned?: boolean;
      bootDeadline?: StdioAcpBootDeadline;
    },
  ): Promise<AcpWarmPoolEntry | null> {
    const bootDeadline = args.bootDeadline ?? this.createBootDeadline();
    const initResponse = await this.requestWithBootDeadline<AcpInitializeResponse>(
      server,
      client,
      bootDeadline,
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: this.buildClientCapabilities(),
        clientInfo: { name: "penumbra", version: "1.0.0" },
      },
    );
    const authMethods = initResponse.authMethods ?? [];
    if (authMethods.length > 0) {
      const chosenAuthId = selectAuthMethodId(authMethods, this.opts.authMethodId, args.mergedEnv);
      await this.requestWithBootDeadline(server, client, bootDeadline, "authenticate", {
        methodId: chosenAuthId,
      });
    }
    if (!args.warmPoolEnabled || !this.deps.pool) return null;
    return (
      this.deps.pool.deposit(args.poolKey, {
        handle: server,
        client,
        specHash: args.specHash,
        pinned: args.pinned,
      }) ?? null
    );
  }

  /**
   * Eagerly establish + deposit a warm connection WITHOUT running a dispatch.
   * Handshake-only: no session/new, no session/prompt, no per-dispatch handlers,
   * no holder ref — the deposited entry is left idle so the next matching dispatch
   * acquires it as a reuse hit (this is what defeats first-poll-wins worker spread).
   */
  async prewarm(signal?: AbortSignal): Promise<{ deposited: boolean; poolKey: string }> {
    const cwd = this.opts.cwd ?? process.cwd();
    const poolScope = this.opts.repoRoot ?? cwd;
    const poolKey = poolKeyFor({
      agent: this.opts.agentName ?? this.opts.model ?? this.opts.binary,
      cwd: poolScope,
    });
    const warmPoolEnabled = this.opts.warmPool === true && this.deps.pool !== undefined;
    if (!warmPoolEnabled) return { deposited: false, poolKey };
    if (signal?.aborted === true)
      throw (signal.reason as Error | undefined) ?? new Error("prewarm aborted");

    const specHash = acpSpecHash({
      binary: this.opts.binary,
      args: this.opts.args,
      model: this.opts.model,
    });
    const mergedEnv = this.buildMergedEnv();
    const { server, client } = await this.spawnAcpServer(cwd, mergedEnv, signal);
    try {
      const bootDeadline = this.createBootDeadline();
      const entry = await this.handshakeAndDeposit(server, client, {
        mergedEnv,
        specHash,
        poolKey,
        warmPoolEnabled,
        pinned: true,
        bootDeadline,
      });
      return { deposited: entry !== null, poolKey };
    } catch (err) {
      server.kill();
      throw err;
    }
  }

  private acquireWarm(
    poolKey: string,
    specHash: string,
    holderId: string,
  ): { entry: AcpWarmPoolEntry | null; missReason?: string; poolKeys?: string[] } {
    if (this.opts.warmPool !== true || !this.deps.pool) return { entry: null };
    const missReason = this.deps.pool.peekMissReason?.(poolKey, specHash);
    const poolKeys = this.deps.pool.debugKeys?.();
    const entry = this.deps.pool.acquire(holderId, poolKey, specHash);
    return { entry, missReason, poolKeys };
  }

  private async acquireOrSpawn(args: {
    poolKey: string;
    specHash: string;
    holderId: string;
    cwd: string;
    mergedEnv: Record<string, string>;
    input: DispatchInput;
    dispatchStartTs: number;
  }): Promise<AcquireOrSpawnResult> {
    const { entry, missReason, poolKeys } = this.acquireWarm(
      args.poolKey,
      args.specHash,
      args.holderId,
    );
    if (entry) {
      emitLifecycle(args.input, "acp.session.reuse", {
        adapter: this.kind,
        pool_key: args.poolKey,
        framework_overhead_ms: Date.now() - args.dispatchStartTs,
      });
      return {
        server: entry.handle,
        client: entry.client,
        pooledEntry: entry,
        reusedSession: true,
      };
    }
    const spawned = await this.spawnAcpServer(args.cwd, args.mergedEnv, args.input.signal);
    const warmPoolEnabled = this.opts.warmPool === true && this.deps.pool !== undefined;
    emitLifecycle(args.input, "acp.server.start", {
      adapter: this.kind,
      binary: this.opts.binary,
      pid: spawned.server.pid,
      ...(warmPoolEnabled
        ? {
            pool_key: args.poolKey,
            warm_miss: missReason ?? "unknown",
            pool_keys: poolKeys ?? [],
          }
        : {}),
    });
    return {
      server: spawned.server,
      client: spawned.client,
      pooledEntry: null,
      reusedSession: false,
    };
  }

  private async createSession(
    server: StdioAcpHandle,
    client: StdioAcpClient,
    bootDeadline: StdioAcpBootDeadline,
    cwd: string,
    input: DispatchInput,
    mergedEnv: Record<string, string>,
  ): Promise<string> {
    const mcpServers = this.opts.mcpServers ?? [];
    // Scope dispatch identity env injection to the penumbra-mcp server only —
    // never leak handoff/tick identifiers to third-party stdio MCPs.
    const mcpServersWithEnv = buildMcpServersWithEnv(mcpServers, input, mergedEnv);
    const sessionParams: SessionNewParams = {
      cwd,
      mcpServers: mcpServersWithEnv,
    };
    if (this.opts.model !== undefined) sessionParams.model = this.opts.model;
    const claudeMeta = buildClaudeCodeMeta(this.opts);
    if (claudeMeta) sessionParams._meta = claudeMeta;
    const session = await this.requestWithBootDeadline<AcpSessionNewResponse>(
      server,
      client,
      bootDeadline,
      "session/new",
      sessionParams,
    );
    return session.sessionId;
  }

  private async runModelWarmup(
    client: StdioAcpClient,
    sessionId: string,
    input: DispatchInput,
    state: { warmupTimedOutRef: { current: boolean } },
  ): Promise<void> {
    const prompt = this.opts.modelWarmupPrompt;
    if (typeof prompt !== "string" || prompt.length === 0) return;
    const warmupStart = Date.now();
    const warmupTimer: { ref: ReturnType<typeof setTimeout> | null } = { ref: null };
    try {
      await Promise.race([
        client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
        new Promise<never>((_, reject) => {
          warmupTimer.ref = setTimeout(() => {
            state.warmupTimedOutRef.current = true;
            reject(new Error("model warmup timeout"));
          }, MODEL_WARMUP_TIMEOUT_MS);
        }),
      ]);
      emitLifecycle(input, "acp.model_warmup", {
        adapter: this.kind,
        session_id: sessionId,
        duration_ms: Date.now() - warmupStart,
      });
    } catch (err) {
      emitLifecycle(input, "acp.model_warmup.failed", {
        adapter: this.kind,
        session_id: sessionId,
        error: String(err),
      });
    } finally {
      if (warmupTimer.ref !== null) clearTimeout(warmupTimer.ref);
    }
  }

  private buildPromptParams(sessionId: string, input: DispatchInput): SessionPromptParams {
    const params: SessionPromptParams = {
      sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    };
    if (input.handoff_id !== undefined) {
      params._meta = {
        penumbraHandoffId: input.handoff_id,
        penumbra: { handoff_id: input.handoff_id },
      };
    }
    return params;
  }

  private cleanupConnection(args: {
    server: StdioAcpHandle | null;
    pooledEntry: AcpWarmPoolEntry | null;
    poolKey: string;
    holderId: string;
    warmPoolEnabled: boolean;
    errorThrown: boolean;
    warmupTimedOut: boolean;
  }): void {
    if (
      args.warmPoolEnabled &&
      args.pooledEntry &&
      !args.errorThrown &&
      !args.warmupTimedOut &&
      this.deps.pool
    ) {
      this.deps.pool.release(args.holderId, args.poolKey);
      return;
    }
    if (args.warmPoolEnabled && args.pooledEntry && this.deps.pool) {
      this.deps.pool.evict(args.poolKey, args.pooledEntry);
    }
    if (args.server && args.pooledEntry?.tornDown !== true) {
      args.server.kill();
    }
  }

  private prepareColdRetry(
    err: unknown,
    state: DispatchState,
    warmPoolEnabled: boolean,
    poolKey: string,
  ): StdioAcpAdapter | null {
    const retryEntry = state.pooledEntry;
    if (!retryEntry || !shouldRetryColdDispatch(err, warmPoolEnabled, retryEntry)) {
      return null;
    }
    this.deps.pool?.evict(poolKey, retryEntry);
    state.pooledEntry = null;
    state.server = null;
    return new StdioAcpAdapter(
      { ...this.opts, warmPool: false },
      {
        startServer: this.deps.startServer,
        createClient: this.deps.createClient,
        thoughtCapture: this.deps.thoughtCapture,
      },
    );
  }

  private async runPromptInteraction(args: {
    client: StdioAcpClient;
    sessionId: string;
    input: DispatchInput;
    state: DispatchState;
    armPromptTimeout: () => void;
    lifecycleHandles: ServerLifecycleHandles;
    adapterKind: string;
  }): Promise<AcpPromptResponse | null> {
    const promptPromise = args.client.request(
      "session/prompt",
      this.buildPromptParams(args.sessionId, args.input),
    );
    const promptTimeoutPromise = new Promise<never>((_, reject) => {
      args.state.promptTimeoutRejector = reject;
      args.armPromptTimeout();
    });
    const heartbeatTimer = createHeartbeatTimer(
      args.input,
      args.state,
      args.lifecycleHandles.serverAliveRef,
      args.sessionId,
      args.adapterKind,
    );
    try {
      const response = (await Promise.race([
        promptPromise,
        args.lifecycleHandles.toolUseRejection.promise,
        promptTimeoutPromise,
        args.lifecycleHandles.sessionExitRejection.promise,
      ])) as AcpPromptResponse | null;
      emitLifecycle(args.input, "acp.session.end", {
        adapter: args.adapterKind,
        session_id: args.sessionId,
        stop_reason: response?.stopReason ?? null,
      });
      return response;
    } finally {
      args.state.promptTimeoutRejector = null;
      clearPromptTimer(args.state);
      clearInterval(heartbeatTimer);
    }
  }

  private async *handleDispatchCatch(
    err: unknown,
    state: DispatchState,
    warmPoolEnabled: boolean,
    poolKey: string,
    input: DispatchInput,
  ): AsyncIterable<DispatchEvent> {
    const coldAdapter = this.prepareColdRetry(err, state, warmPoolEnabled, poolKey);
    if (coldAdapter) {
      for await (const event of coldAdapter.dispatchStream(input)) {
        yield event;
      }
      return;
    }
    augmentDispatchError(err, state.server, state.accumulatedText);
    state.errorThrown = true;
    throw err;
  }

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const setup = computeDispatchConstants(this.opts, this.deps.pool, input);
    const { dispatchStartTs, cwd, requestTimeoutMs, warmPoolEnabled, poolKey, specHash, holderId } =
      setup;
    const state = createDispatchState();
    try {
      const mergedEnv = this.buildMergedEnv();
      const bootDeadline = this.createBootDeadline();

      const warm = this.acquireWarm(poolKey, specHash, holderId);
      const acquired: AcquireOrSpawnResult = warm.entry
        ? acquireReuseResult(warm.entry, input, this.kind, poolKey, dispatchStartTs)
        : buildSpawnResult({
            spawned: await this.spawnAcpServer(cwd, mergedEnv, input.signal),
            input,
            adapterKind: this.kind,
            binary: this.opts.binary,
            warmPoolEnabled,
            poolKey,
            missReason: warm.missReason,
            poolKeys: warm.poolKeys,
          });
      const { client, server } = { client: acquired.client, server: acquired.server };
      state.server = server;
      state.pooledEntry = acquired.pooledEntry;

      const armPromptTimeout = (): void => {
        armPromptTimeoutImpl(state, server, requestTimeoutMs);
      };
      const turnCtx: DispatchTurnContext = buildInlineTurnContext({
        cwd,
        client,
        input,
        state,
        opts: this.opts,
        thoughtCapture: this.deps.thoughtCapture,
        armPromptTimeout,
      });
      registerFsHandlers(turnCtx, this.opts);
      registerTerminalHandlers(turnCtx, this.opts);
      registerPermissionHandler(turnCtx, this.opts);

      if (!acquired.reusedSession) {
        const initResponse = await this.requestWithBootDeadline<AcpInitializeResponse>(
          server,
          client,
          bootDeadline,
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: this.buildClientCapabilities(),
            clientInfo: { name: "penumbra", version: "1.0.0" },
          },
        );
        const authMethods = initResponse.authMethods ?? [];
        if (authMethods.length > 0) {
          const chosenAuthId = selectAuthMethodId(authMethods, this.opts.authMethodId, mergedEnv);
          await this.requestWithBootDeadline(server, client, bootDeadline, "authenticate", {
            methodId: chosenAuthId,
          });
        }
        state.pooledEntry = this.maybeDepositWarm({
          server,
          client,
          warmPoolEnabled,
          poolKey,
          specHash,
        });
        state.pooledEntry?.refs.add(holderId);
      }

      const session = await this.requestWithBootDeadline<AcpSessionNewResponse>(
        server,
        client,
        bootDeadline,
        "session/new",
        buildSessionNewParams(this.opts, cwd, input, mergedEnv),
      );
      const sessionId = handleSessionCreated({
        session,
        adapterKind: this.kind,
        input,
        client,
        state,
        dispatchStartTs,
      });

      const lifecycleHandles = setupServerLifecycleHandles(server, state, turnCtx);
      const sessionUpdateHandler = typedNotify<AcpSessionUpdateParams>(
        buildSessionUpdateHandler(turnCtx, state, armPromptTimeout),
      );
      client.on("session/update", sessionUpdateHandler);

      if (!acquired.reusedSession && this.opts.modelWarmupPrompt !== undefined) {
        const warmupResult = { warmupTimedOutRef: { current: false } };
        await this.runModelWarmup(client, sessionId, input, warmupResult);
        state.warmupTimedOut = warmupResult.warmupTimedOutRef.current;
        // Drop whatever the warmup turn accumulated (the `/model` ack) so the
        // task response below starts from a clean buffer.
        state.accumulatedText = "";
        state.lastSessionUpdateTs = Date.now();
      }

      const promptResponse = await this.runPromptInteraction({
        client,
        sessionId,
        input,
        state,
        armPromptTimeout,
        lifecycleHandles,
        adapterKind: this.kind,
      });
      yield buildDispatchDoneEvent(state, promptResponse);
    } catch (err) {
      yield* this.handleDispatchCatch(err, state, warmPoolEnabled, poolKey, input);
    } finally {
      if (input.handoff_id !== undefined) unregisterSession(input.handoff_id);
      this.cleanupConnection({
        server: state.server,
        pooledEntry: state.pooledEntry,
        poolKey,
        holderId,
        warmPoolEnabled,
        errorThrown: state.errorThrown,
        warmupTimedOut: state.warmupTimedOut,
      });
    }
  }
}

interface DispatchState {
  server: StdioAcpHandle | null;
  pooledEntry: AcpWarmPoolEntry | null;
  accumulatedText: string;
  frameworkOverheadMs: number | undefined;
  errorThrown: boolean;
  warmupTimedOut: boolean;
  promptTimer: ReturnType<typeof setTimeout> | null;
  promptTimeoutRejector: ((err: Error) => void) | null;
  lastSessionUpdateTs: number;
}

interface InlineTurnContextArgs {
  cwd: string;
  client: StdioAcpClient;
  input: DispatchInput;
  state: DispatchState;
  opts: StdioAcpOptions;
  thoughtCapture?: StdioAcpThoughtCapture;
  armPromptTimeout: () => void;
}

function buildInlineTurnContext(args: InlineTurnContextArgs): DispatchTurnContext {
  const { cwd, client, input, state, opts, thoughtCapture, armPromptTimeout } = args;
  return {
    cwd,
    client,
    input,
    getServer: (): StdioAcpHandle | null => state.server,
    toolUseRejectorRef: { current: null },
    capability: supportsClientCapability(opts),
    thoughtCapture,
    capturePort: opts.capturePort,
    modelLabel: opts.model ?? opts.binary,
    arm: armPromptTimeout,
    markUpdate: (): void => {
      state.lastSessionUpdateTs = Date.now();
    },
    accumulate: (text: string): void => {
      state.accumulatedText += text;
    },
    toolNames: new Map<string, string>(),
  };
}

function clearPromptTimer(state: DispatchState): void {
  if (state.promptTimer !== null) {
    clearTimeout(state.promptTimer);
    state.promptTimer = null;
  }
}

function armPromptTimeoutImpl(
  state: DispatchState,
  server: StdioAcpHandle,
  requestTimeoutMs: number,
): void {
  if (!state.promptTimeoutRejector) return;
  clearPromptTimer(state);
  state.promptTimer = setTimeout(() => {
    const tail = server.getStderrTail();
    const tailHint = tail.length > 0 ? `\n[child stderr tail]\n${tail}` : "";
    state.promptTimeoutRejector?.(
      new Error(
        `stdio-acp: no wire activity (session/update or onRequest) for ${String(requestTimeoutMs)}ms — agent stalled mid-turn${tailHint}`,
      ),
    );
  }, requestTimeoutMs);
}

function createRejectablePromise<T>(): {
  promise: Promise<T>;
  reject: (err: Error) => void;
} {
  let rejectFn: (err: Error) => void = () => {
    /* noop */
  };
  const promise = new Promise<T>((_, reject) => {
    rejectFn = reject;
  });
  return { promise, reject: rejectFn };
}

function registerHandoffInjector(
  input: DispatchInput,
  client: StdioAcpClient,
  sessionId: string,
): void {
  if (input.handoff_id === undefined) return;
  const handoffId = input.handoff_id;
  registerSession(handoffId, {
    adapter: "stdio-acp",
    inject: async (message) => {
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: message.text }],
        _meta: {
          penumbraHandoffId: handoffId,
          penumbra: { handoff_id: handoffId },
        },
      });
    },
  });
}

function shouldRetryColdDispatch(
  err: unknown,
  warmPoolEnabled: boolean,
  pooledEntry: AcpWarmPoolEntry | null,
): boolean {
  return err instanceof AcpSessionEvictedError && warmPoolEnabled && pooledEntry !== null;
}

interface DispatchConstants {
  dispatchStartTs: number;
  cwd: string;
  requestTimeoutMs: number;
  warmPoolEnabled: boolean;
  poolKey: string;
  specHash: string;
  holderId: string;
}

function computeDispatchConstants(
  opts: StdioAcpOptions,
  pool: AcpWarmPool | undefined,
  input: DispatchInput,
): DispatchConstants {
  const cwd = opts.cwd ?? process.cwd();
  const poolScope = opts.repoRoot ?? cwd;
  return {
    dispatchStartTs: Date.now(),
    cwd,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    warmPoolEnabled: opts.warmPool === true && pool !== undefined,
    poolKey: poolKeyFor({
      agent: opts.agentName ?? opts.model ?? opts.binary,
      cwd: poolScope,
    }),
    specHash: acpSpecHash({
      binary: opts.binary,
      args: opts.args,
      model: opts.model,
    }),
    holderId: input.handoff_id ?? input.conversation.id,
  };
}

function createDispatchState(): DispatchState {
  return {
    server: null,
    pooledEntry: null,
    accumulatedText: "",
    frameworkOverheadMs: undefined,
    errorThrown: false,
    warmupTimedOut: false,
    promptTimer: null,
    promptTimeoutRejector: null,
    lastSessionUpdateTs: Date.now(),
  };
}

function buildSpawnResult(args: {
  spawned: { server: StdioAcpHandle; client: StdioAcpClient };
  input: DispatchInput;
  adapterKind: string;
  binary: string;
  warmPoolEnabled: boolean;
  poolKey: string;
  missReason: string | undefined;
  poolKeys: string[] | undefined;
}): AcquireOrSpawnResult {
  emitLifecycle(args.input, "acp.server.start", {
    adapter: args.adapterKind,
    binary: args.binary,
    pid: args.spawned.server.pid,
    ...(args.warmPoolEnabled
      ? {
          pool_key: args.poolKey,
          warm_miss: args.missReason ?? "unknown",
          pool_keys: args.poolKeys ?? [],
        }
      : {}),
  });
  return {
    server: args.spawned.server,
    client: args.spawned.client,
    pooledEntry: null,
    reusedSession: false,
  };
}

function buildSessionNewParams(
  opts: StdioAcpOptions,
  cwd: string,
  input: DispatchInput,
  mergedEnv: Record<string, string>,
): SessionNewParams {
  const mcpServersWithEnv = buildMcpServersWithEnv(opts.mcpServers ?? [], input, mergedEnv);
  const params: SessionNewParams = { cwd, mcpServers: mcpServersWithEnv };
  if (opts.model !== undefined) params.model = opts.model;
  const claudeMeta = buildClaudeCodeMeta(opts);
  if (claudeMeta) params._meta = claudeMeta;
  return params;
}

interface ServerLifecycleHandles {
  serverAliveRef: { current: boolean };
  toolUseRejection: { promise: Promise<never>; reject: (err: Error) => void };
  sessionExitRejection: { promise: Promise<never>; reject: (err: Error) => void };
}

function setupServerLifecycleHandles(
  server: StdioAcpHandle,
  state: DispatchState,
  turnCtx: DispatchTurnContext,
): ServerLifecycleHandles {
  const serverAliveRef: { current: boolean } = { current: true };
  void server.exited.then(() => {
    serverAliveRef.current = false;
  });
  const toolUseRejection = createRejectablePromise<never>();
  turnCtx.toolUseRejectorRef.current = toolUseRejection.reject;
  const sessionExitRejection = createRejectablePromise<never>();
  void server.exited.then((code) => {
    if (state.pooledEntry && code !== 0) {
      sessionExitRejection.reject(new AcpSessionEvictedError());
    }
  });
  return { serverAliveRef, toolUseRejection, sessionExitRejection };
}

function buildSessionUpdateHandler(
  turnCtx: DispatchTurnContext,
  state: DispatchState,
  armPromptTimeout: () => void,
): (params: AcpSessionUpdateParams) => void {
  return (params) => {
    const update = params.update;
    if (!update || typeof update !== "object") return;
    armPromptTimeout();
    state.lastSessionUpdateTs = Date.now();
    dispatchSessionUpdate(turnCtx, update);
  };
}

function createHeartbeatTimer(
  input: DispatchInput,
  state: DispatchState,
  serverAliveRef: { current: boolean },
  sessionId: string,
  adapterKind: string,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!serverAliveRef.current) return;
    if (Date.now() - state.lastSessionUpdateTs < 45_000) return;
    emitLifecycle(input, "agent.heartbeat", {
      adapter: adapterKind,
      idle_ms: Date.now() - state.lastSessionUpdateTs,
      session_id: sessionId,
    });
  }, 60_000);
}

function handleSessionCreated(args: {
  session: AcpSessionNewResponse;
  adapterKind: string;
  input: DispatchInput;
  client: StdioAcpClient;
  state: DispatchState;
  dispatchStartTs: number;
}): string {
  args.state.frameworkOverheadMs = Date.now() - args.dispatchStartTs;
  emitLifecycle(args.input, "acp.session.start", {
    adapter: args.adapterKind,
    session_id: args.session.sessionId,
    framework_overhead_ms: args.state.frameworkOverheadMs,
  });
  registerHandoffInjector(args.input, args.client, args.session.sessionId);
  return args.session.sessionId;
}

function buildDispatchDoneEvent(
  state: DispatchState,
  promptResponse: AcpPromptResponse | null,
): DispatchEvent {
  const classifierDecline = detectStdioAcpClassifierDecline({
    finalText: state.accumulatedText,
    errorText: state.accumulatedText.trim().length === 0 ? JSON.stringify(promptResponse) : null,
  });
  return {
    type: "done",
    result: {
      text: state.accumulatedText,
      meta: {
        framework_overhead_ms: state.frameworkOverheadMs,
        ...(classifierDecline ?? {}),
      },
    },
  };
}

function acquireReuseResult(
  entry: AcpWarmPoolEntry,
  input: DispatchInput,
  adapterKind: string,
  poolKey: string,
  dispatchStartTs: number,
): AcquireOrSpawnResult {
  emitLifecycle(input, "acp.session.reuse", {
    adapter: adapterKind,
    pool_key: poolKey,
    framework_overhead_ms: Date.now() - dispatchStartTs,
  });
  return {
    server: entry.handle,
    client: entry.client,
    pooledEntry: entry,
    reusedSession: true,
  };
}

function augmentDispatchError(
  err: unknown,
  server: StdioAcpHandle | null,
  accumulatedText: string,
): void {
  if (server && err instanceof Error && !err.message.includes("[child stderr tail]")) {
    const tail = server.getStderrTail();
    if (tail.length > 0) err.message = `${err.message}\n[child stderr tail]\n${tail}`;
  }
  if (err instanceof Error) {
    const classifierDecline = detectStdioAcpClassifierDecline({
      finalText: accumulatedText,
      errorText: err.message,
    });
    if (classifierDecline) Object.assign(err, classifierDecline);
  }
}
