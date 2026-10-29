import {
  type DispatchEventInput,
  evaluateProfileToolCall,
  FsPathError,
  PERMISSION_PROFILE_MCP_ALLOWLIST,
  renderSandboxExecProfile,
  resolveInsideWorktree,
  resolveSandboxDenyRoots,
} from "@penumbra/core";
import path from "node:path";

import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import type { CapturePort } from "../worker/capture-port.js";
import type { McpServer } from "./acp-types.js";

import { type ClassifierDeclineMeta, detectClassifierDecline } from "../classifier-decline.js";
import { SandboxUnavailableError } from "../worker/sandbox-spawn.js";
import { registerSession, unregisterSession } from "../worker/session-registry.js";
import {
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalCapExceededError,
  TerminalNotFoundError,
} from "../worker/write-tools-errors.js";
import { executeReadTextFile, ReadTextFileError } from "./acp-fs.js";
import { resolveWarmPrewarmCap, totalAcpWarmPoolEntryCount } from "./acp-warm-pool-registry.js";
import {
  acpSpecHash,
  type AcpWarmPool,
  type AcpWarmPoolEntry,
  type AcpWarmPoolPrewarmEviction,
  poolKeyFor,
} from "./acp-warm-pool.js";
import { StdioAcpClient } from "./stdio-acp-client.js";
import {
  type AcpPermissionRequest,
  handleStdioAcpPermissionRequest,
  StdioAcpPermissionContext,
} from "./stdio-acp-permission.js";
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
  sandbox_unavailable: -32012,
};

interface ErrorWithCode extends Error {
  code?: unknown;
}

interface MappedError extends Error {
  code?: number;
}

class InternalTerminalHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalTerminalHandlerError";
  }
}

function isSafeInternalTerminalError(err: unknown): boolean {
  return (
    err instanceof TerminalNotFoundError ||
    err instanceof TerminalCapExceededError ||
    err instanceof OperationRejectedError ||
    err instanceof SandboxUnavailableError ||
    err instanceof InternalTerminalHandlerError
  );
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
  if (err instanceof Error) {
    if (isSafeInternalTerminalError(err)) {
      return new Error(err.message);
    }
    return err;
  }
  return new Error(String(err));
}

function safeInternalTerminalMessage(err: unknown): string | null {
  if (err instanceof TerminalNotFoundError) return "terminal not found";
  if (err instanceof TerminalCapExceededError) {
    return `terminal cap exceeded (max=${String(err.max)})`;
  }
  if (
    err instanceof OperationRejectedError ||
    err instanceof SandboxUnavailableError ||
    err instanceof InternalTerminalHandlerError
  ) {
    return err.message;
  }
  return null;
}

export function redactTerminalErrorMessage(message: unknown, code = -32000): string {
  let messageLength = 0;
  try {
    if (typeof message === "string") {
      messageLength = message.length;
    } else if (message !== null && message !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve the established redaction length semantics for arbitrary thrown values.
      messageLength = String(message).length;
    }
  } catch {
    messageLength = 0;
  }
  const safeCode = Number.isFinite(code) ? Math.trunc(code) : -32000;
  return `terminal error redacted (code=${String(safeCode)}, messageLength=${String(messageLength)})`;
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
const TERMINAL_FAILURE_AUDIT_TIMEOUT_MS = 2_000;
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

async function emitTerminalFailure(
  input: DispatchInput,
  method: string,
  err: unknown,
): Promise<Error> {
  const mapped = mapWriteToolsError(err);
  const mappedCode = (mapped as { code?: unknown }).code;
  const code = typeof mappedCode === "number" ? mappedCode : -32000;
  const terminalMessage =
    safeInternalTerminalMessage(err) ?? redactTerminalErrorMessage(mapped.message, code);
  // Unknown terminal failures can include caller argv with credentials when
  // trust_mode=all auto-approves, so only typed internal failures keep text.
  try {
    emitLifecycle(input, "terminal.failed", {
      handoff_id: input.handoff_id ?? input.eventContext?.handoffId ?? "unknown",
      method,
      code,
      message: terminalMessage,
    });
  } catch (lifecycleErr) {
    console.warn("stdio-acp: terminal failure lifecycle emit failed", {
      method,
      code,
      message: lifecycleErr instanceof Error ? lifecycleErr.message : String(lifecycleErr),
    });
  }
  if (input.executor) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const audit = Promise.resolve(
        input.executor.auditTerminalFailure({
          handoff_id: input.handoff_id ?? input.eventContext?.handoffId ?? "unknown",
          method,
          code,
          message: terminalMessage,
        }),
      );
      const auditTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `terminal failure audit timed out after ${String(TERMINAL_FAILURE_AUDIT_TIMEOUT_MS)}ms`,
            ),
          );
        }, TERMINAL_FAILURE_AUDIT_TIMEOUT_MS);
      });
      await Promise.race([audit, auditTimeout]);
    } catch (auditErr: unknown) {
      console.warn("stdio-acp: terminal failure audit emit failed", {
        method,
        code,
        message: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  // Do not attach the mapped error as cause: pino serializes error causes and
  // would re-leak the raw text that terminalMessage intentionally redacted.
  const terminalError = new Error(terminalMessage) as MappedError;
  terminalError.code = code;
  return terminalError;
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
   *   long-lived agents that only need MCP tools (e.g., task refiners).
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
  /**
   * Permission mode advertised to the ACP agent during initialize and
   * session/new. Mirrors claude-agent-sdk's PermissionMode union. When unset,
   * the adapter falls back to dispatch-time `input.trust_mode`: `"all"` maps
   * to `"bypassPermissions"` (auto-approve every exec/shell/git tool call);
   * any other value leaves the field unset so the agent applies its default.
   *
   * Surfaced because the official ACP ClientCapabilities schema has no
   * permission field — agents that honor a trust hint (e.g. devin's chisel
   * server, claude-agent-sdk) read it out of the extensibility-reserved
   * `_meta` block on initialize.clientCapabilities and session/new._meta.
   * The exact wire shape is also mirrored at the top of `clientCapabilities`
   * for agents that read a non-spec `permission` field. This field is adapter
   * internal and is not reachable from agents.yaml; the strict seat schema
   * rejects `permissionMode`. ACP-side mode control belongs in a future
   * `session/set_mode` request, which this adapter does not implement yet.
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
}

export interface StdioAcpThoughtInput {
  handoffId: string;
  adapter: "stdio-acp";
  agentName: string;
  text: string;
  tokenCount?: number;
  ts?: string;
}

export interface StdioAcpThoughtCapture {
  recordThought: (input: StdioAcpThoughtInput) => void;
  /** #297: buffer one streamed chunk; the capture writes coalesced rows. */
  appendThoughtChunk?: (input: StdioAcpThoughtInput) => void;
  /** #297: write a dispatch's buffered thought text as one row. */
  flush?: (handoffId: string) => void;
}

interface StdioAcpAdapterDeps {
  startServer: (opts: StartStdioAcpServerOptions) => Promise<StdioAcpHandle>;
  createClient: (handle: StdioAcpHandle) => StdioAcpClient;
  pool?: AcpWarmPool;
  totalPoolEntryCount?: () => number;
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

interface AcpClientPermissionCapability {
  mode?: string;
}

interface AcpClientCapabilitiesMeta {
  permissionMode?: string;
  permission?: AcpClientPermissionCapability;
}

interface AcpClientCapabilities {
  fs?: AcpClientFsCapability;
  terminal?: boolean;
  /**
   * Non-spec top-level hint for ACP servers that read a `permission` field
   * directly off clientCapabilities. Paired with `_meta.permissionMode` so
   * spec-compliant readers can pick the hint up through the official
   * extensibility channel.
   */
  permission?: AcpClientPermissionCapability;
  _meta?: AcpClientCapabilitiesMeta;
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
  // #328: ACP session model state ({ currentModelId, availableModels: [{ modelId }] }) from
  // agents that support session/set_model. Untrusted wire data; read only via decideSessionModel.
  models?: unknown;
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
  outputByteLimit?: number;
}

interface AcpTerminalIdParams {
  terminal_id?: string;
  terminalId?: string;
}

interface AcpTextContent {
  type?: string;
  text?: string;
}

interface AcpSessionUpdateMeta {
  codex?: { phase?: unknown };
}

interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: AcpTextContent;
  _meta?: AcpSessionUpdateMeta;
  name?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
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
  sessionId?: unknown;
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
  /**
   * Non-spec trust hint mirrored onto `session/new._meta` for agents whose
   * ACP server reads the permission level off the session params rather than
   * (or in addition to) the initialize handshake.
   */
  permissionMode?: string;
  permission?: { mode: string };
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
  // A permission profile's allowlist is authoritative: it strips any
  // yaml-level PENUMBRA_MCP_TOOL_ALLOWLIST on the server AND supersedes the
  // long-lived tick allowlist, so exactly one allowlist entry is injected.
  const profileEnv: EnvEntry[] =
    input.permission_profile !== undefined && input.permission_profile !== null
      ? [
          {
            name: "PENUMBRA_MCP_TOOL_ALLOWLIST",
            value: PERMISSION_PROFILE_MCP_ALLOWLIST[input.permission_profile].join(","),
          },
        ]
      : [];
  const storageRootEnv: EnvEntry[] =
    mergedEnv.PENUMBRA_STORAGE_ROOT !== undefined
      ? [{ name: "PENUMBRA_STORAGE_ROOT", value: mergedEnv.PENUMBRA_STORAGE_ROOT }]
      : [];
  const shouldInjectDispatchEnv =
    input.handoff_id !== undefined ||
    longLivedEnv.length > 0 ||
    storageRootEnv.length > 0 ||
    profileEnv.length > 0;
  if (!shouldInjectDispatchEnv) return mcpServers;

  return mcpServers.map((server): McpServer => {
    if (!isPenumbraMcp(server)) return server;
    const candidate = server as McpServerWithEnv;
    const existingEnv = candidate.env ?? [];
    const filtered = existingEnv.filter((entry) => {
      const name = String(entry.name);
      if (profileEnv.length > 0 && name === "PENUMBRA_MCP_TOOL_ALLOWLIST") return false;
      return !PENUMBRA_MCP_INJECTED_ENV_KEYS.has(name);
    });
    const handoffEnv: EnvEntry[] =
      input.handoff_id !== undefined
        ? [{ name: "PENUMBRA_HANDOFF_ID", value: input.handoff_id }]
        : [];
    const nextEnv: McpServerEnvEntry[] = [
      ...filtered,
      ...handoffEnv,
      { name: "PENUMBRA_MCP_ORIGIN", value: PENUMBRA_MCP_ORIGIN_FLEET_WORKER },
      ...storageRootEnv,
      ...(profileEnv.length > 0
        ? longLivedEnv.filter((entry) => entry.name !== "PENUMBRA_MCP_TOOL_ALLOWLIST")
        : longLivedEnv),
      ...profileEnv,
    ];
    return { ...server, env: nextEnv } as McpServer;
  });
}

/**
 * Resolves the permission mode to advertise during the ACP handshake.
 * Precedence: explicit `opts.permissionMode` > derived from `input.trust_mode`.
 * trust_mode === "all" promotes to "bypassPermissions"; trust_mode === "config"
 * (or unset) returns undefined so the agent's own default applies.
 */
export function resolvePermissionMode(
  opts: Pick<StdioAcpOptions, "permissionMode">,
  input?: Pick<DispatchInput, "trust_mode">,
): StdioAcpOptions["permissionMode"] | undefined {
  if (opts.permissionMode !== undefined) return opts.permissionMode;
  if (input?.trust_mode === "all") return "bypassPermissions";
  return undefined;
}

/**
 * Builds the initialize.clientCapabilities payload. Exported (via the class
 * wrapper) so unit tests can pin both fs/terminal and the trust-hint surface
 * without instantiating the full adapter.
 */
export function buildClientCapabilities(
  opts: StdioAcpOptions,
  input?: DispatchInput,
): AcpClientCapabilities {
  const capabilities: AcpClientCapabilities = {};
  const fs: AcpClientFsCapability = {};
  if (opts.fsReadTextFile === true) fs.readTextFile = true;
  if (opts.fsWriteTextFile === true) fs.writeTextFile = true;
  if (fs.readTextFile === true || fs.writeTextFile === true) capabilities.fs = fs;
  if (opts.terminal === true) capabilities.terminal = true;
  const mode = resolvePermissionMode(opts, input);
  if (mode !== undefined) {
    capabilities.permission = { mode };
    capabilities._meta = { permissionMode: mode, permission: { mode } };
  }
  return capabilities;
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

function isAuthenticationRequiredError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /^stdio-acp-client: Authentication required(?:|: .+) \(code: -32000\)$/.test(err.message)
  );
}

// #328: how to apply options.model given the session/new `models` field.
// "unadvertised": no usable availableModels list; "unlisted": listed, but not this id.
type SessionModelAction = "current" | "select" | "unadvertised" | "unlisted";

function decideSessionModel(model: string, models: unknown): SessionModelAction {
  if (!models || typeof models !== "object") return "unadvertised";
  const state = models as { availableModels?: unknown; currentModelId?: unknown };
  const available = state.availableModels;
  if (!Array.isArray(available)) return "unadvertised";
  if (state.currentModelId === model) return "current";
  const listed = available.some(
    (entry: unknown): boolean =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { modelId?: unknown }).modelId === model,
  );
  return listed ? "select" : "unlisted";
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
  accumulate: (text: string, phase?: string) => void;
  markSegmentBreak: () => void;
  permissionContext: StdioAcpPermissionContext;
  toolNames: Map<string, string>;
}

// Profile gate for the executor-backed write surface. ACP agents address
// fs/write_text_file and terminal/create directly on the adapter; the profile
// is re-evaluated at this request boundary, ahead of the executor's own
// permission-callback gate, so a profile deny holds even when the executor's
// callback was built without profile awareness. Fail-closed: deny or
// uninspectable input throws OperationRejectedError (maps to -32004).
function assertProfileAllowsWriteTool(
  input: DispatchInput,
  toolName: string,
  rawInput: unknown,
): void {
  const profile = input.permission_profile;
  if (profile === undefined || profile === null) return;
  const decision = evaluateProfileToolCall(profile, toolName, rawInput);
  if (decision.decision === "deny") {
    throw new OperationRejectedError(`permission_profile ${profile}: ${decision.reason}`);
  }
}

// Render the Layer B sandbox-exec profile for a profile dispatch: deny
// file-write under the resolved dispatch cwd (the worktree) plus every extra
// mutable root the worker attached (caller cwd, project root, fleet base).
// SBPL subpath rules match real paths, so all roots must be realpath'd —
// /var→/private/var and symlinked parents otherwise let the deny silently
// miss. startServer fails closed on platforms without sandbox-exec rather
// than spawn unsandboxed. resolveSandboxDenyRoots is synchronous so the
// unprofiled dispatch path gains no extra microtask hop.
function resolveDispatchSandboxProfile(input: DispatchInput, cwd: string): string | undefined {
  const profile = input.permission_profile;
  if (profile === undefined || profile === null) return undefined;
  return renderSandboxExecProfile(resolveSandboxDenyRoots(cwd, input.sandbox_deny_roots ?? []));
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
          assertProfileAllowsWriteTool(ctx.input, "fs.write_text_file", {
            path: params.path,
            content_bytes:
              typeof params.content === "string" ? Buffer.byteLength(params.content, "utf8") : 0,
          });
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

async function validateTerminalCwd(cwd: string | undefined, worktreeRoot: string): Promise<string> {
  // Missing cwd and "." intentionally default to the dispatch worktree root.
  if (cwd === undefined || cwd === ".") return await resolveInsideWorktree(".", worktreeRoot);
  try {
    return await resolveInsideWorktree(cwd, worktreeRoot);
  } catch (err) {
    if (err instanceof FsPathError) {
      return await recoverTerminalCwdFromFsPathError(cwd, worktreeRoot, err);
    }
    throw err;
  }
}

async function recoverTerminalCwdFromFsPathError(
  cwd: string,
  worktreeRoot: string,
  err: FsPathError,
): Promise<string> {
  if (err.code === "outside_worktree") throw new OutsideWorktreeError(err.message);
  // Missing cwd paths are acceptable only after resolveInsideWorktree has
  // checked the nearest existing ancestor for symlink escapes.
  if (err.code === "not_found") {
    const worktreeReal = await resolveInsideWorktree(".", worktreeRoot);
    return path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(worktreeReal, cwd);
  }
  throw err;
}

const terminalIdFromParams = (method: string, params: AcpTerminalIdParams): string => {
  const terminalId = params.terminal_id ?? params.terminalId;
  if (terminalId === undefined)
    throw new InternalTerminalHandlerError(`${method}: missing terminal_id or terminalId`);
  return terminalId;
};

const commandStringFromParams = (params: AcpTerminalCreateParams): string =>
  params.command ?? params.args?.join(" ") ?? "";

const commandProgramFromParams = (params: AcpTerminalCreateParams): string => {
  const command = commandStringFromParams(params).trimStart();
  return command.split(/\s+/, 1)[0] ?? "";
};

const withTerminalAliases = (result: unknown): unknown => {
  if (result === null || typeof result !== "object") return result;
  const aliases: Record<string, unknown> = {};
  const terminalId = (result as { terminal_id?: unknown }).terminal_id;
  if (terminalId !== undefined && !("terminalId" in result)) {
    aliases.terminalId = terminalId;
  }
  const exitStatus = (result as { exit_status?: unknown }).exit_status;
  if (exitStatus !== undefined && !("exitStatus" in result)) {
    aliases.exitStatus = exitStatus;
  }
  if (Object.keys(aliases).length === 0) return result;
  return { ...result, ...aliases };
};

function registerTerminalCreateHandler(ctx: DispatchTurnContext): void {
  const { client, input, arm } = ctx;
  client.onRequest(
    "terminal/create",
    typedRequest<AcpTerminalCreateParams>(async (params) => {
      arm();
      try {
        if (!input.executor) throw new Error("terminal/create: no executor");
        // A non-string argv is malformed JSON-RPC input (-32602), not a
        // profile deny: validate before the gate and the executor so an
        // uninspectable vector can never reach either.
        const args: unknown = params.args;
        if (
          args !== undefined &&
          !(Array.isArray(args) && args.every((a) => typeof a === "string"))
        ) {
          const invalid = new Error(
            "terminal/create: args must be an array of strings",
          ) as MappedError;
          invalid.code = -32602;
          throw invalid;
        }
        assertProfileAllowsWriteTool(input, "terminal.create", {
          argv: params.args ?? null,
          cmd: params.command ?? null,
        });
        const resolvedCwd = await validateTerminalCwd(params.cwd, ctx.cwd);
        if (input.trust_mode === "all") {
          const command = commandStringFromParams(params);
          // eslint-disable-next-line no-console -- Preserve the established operator-facing auto-approval log.
          console.info(
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Preserve the established numeric command-length log field.
            `stdio-acp: terminal/create auto-approved cwd=${resolvedCwd} program=${commandProgramFromParams(params)} commandLength=${command.length}`,
          );
        }
        const result = await input.executor.terminalCreate(
          {
            command: params.command,
            argv: params.args,
            cwd: resolvedCwd,
            output_byte_limit: params.output_byte_limit ?? params.outputByteLimit,
          },
          {
            toolName: "terminal.create",
            rawInput: {
              argv: params.args ?? null,
              cmd: params.command ?? null,
              cwd: resolvedCwd,
            },
            dispatchId: input.handoff_id ?? "unknown",
          },
        );
        return withTerminalAliases(result);
      } catch (err) {
        throw await emitTerminalFailure(input, "terminal/create", err);
      } finally {
        arm();
      }
    }),
  );
}

type TerminalExecutor = NonNullable<DispatchInput["executor"]>;

function registerTerminalCommandHandler(
  ctx: DispatchTurnContext,
  method: string,
  fn: (executor: TerminalExecutor, terminalId: string) => Promise<unknown>,
): void {
  const { client, input, arm } = ctx;
  client.onRequest(
    method,
    typedRequest<AcpTerminalIdParams>(async (params) => {
      arm();
      try {
        const executor = input.executor;
        if (!executor) throw new Error(`${method}: no executor`);
        return withTerminalAliases(await fn(executor, terminalIdFromParams(method, params)));
      } catch (err) {
        throw await emitTerminalFailure(input, method, err);
      } finally {
        arm();
      }
    }),
  );
}

function registerTerminalHandlers(ctx: DispatchTurnContext, opts: StdioAcpOptions): void {
  if (opts.terminal !== true) return;
  registerTerminalCreateHandler(ctx);
  registerTerminalCommandHandler(
    ctx,
    "terminal/output",
    async (executor, terminalId) => await executor.terminalOutput({ terminal_id: terminalId }),
  );
  registerTerminalCommandHandler(
    ctx,
    "terminal/wait_for_exit",
    async (executor, terminalId) => await executor.terminalWaitForExit({ terminal_id: terminalId }),
  );
  registerTerminalCommandHandler(ctx, "terminal/release", async (executor, terminalId) => {
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Preserve the executor response while retaining the empty-object fallback.
    const result = (await executor.terminalRelease({ terminal_id: terminalId })) as unknown;
    return result ?? {};
  });
  registerTerminalCommandHandler(ctx, "terminal/kill", async (executor, terminalId) => {
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Preserve the executor response while retaining the empty-object fallback.
    const result = (await executor.terminalKill({ terminal_id: terminalId })) as unknown;
    return result ?? {};
  });
}

function registerPermissionHandler(ctx: DispatchTurnContext, opts: StdioAcpOptions): void {
  if (!supportsClientCapability(opts)) return;
  ctx.client.onRequest(
    "session/request_permission",
    typedRequest<AcpPermissionRequest>(async (params) => {
      ctx.arm();
      try {
        return await handleStdioAcpPermissionRequest(ctx.input, ctx.permissionContext, params);
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

const CODEX_FINAL_ANSWER_PHASE = "final_answer";

function codexChunkPhase(update: AcpSessionUpdate): string | undefined {
  // A null or empty phase is normalised to undefined (phase-less chunk).
  const phase = update._meta?.codex?.phase;
  return typeof phase === "string" && phase.length > 0 ? phase : undefined;
}

// A tool call or thought between two message chunks ends a message segment.
// Without a separator the next segment's first line is glued onto the last
// line of the previous one, so line-initial markers like CHECK_RESULT are lost.
function appendMessageSegment(buffer: string, text: string, segmentBreak: boolean): string {
  if (segmentBreak && buffer.length > 0 && !buffer.endsWith("\n")) return `${buffer}\n${text}`;
  return buffer + text;
}

function handleAgentMessageChunk(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  const content = update.content;
  if (content?.type !== "text" || typeof content.text !== "string") return;
  ctx.accumulate(content.text, codexChunkPhase(update));
  ctx.capturePort?.emit({ kind: "agent_message_chunk", content: content.text });
}

function handleAgentThoughtChunk(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  const content = update.content;
  if (content?.type !== "text" || typeof content.text !== "string") return;
  ctx.capturePort?.emit({ kind: "agent_thought_chunk", content: content.text });
  if (ctx.input.handoff_id === undefined) return;
  const capture = ctx.thoughtCapture;
  if (capture === undefined) return;
  const thought: StdioAcpThoughtInput = {
    handoffId: ctx.input.handoff_id,
    adapter: "stdio-acp",
    agentName: ctx.modelLabel,
    text: content.text,
    tokenCount: typeof update.token_count === "number" ? update.token_count : undefined,
  };
  try {
    // #297: coalesce chunks into sentence-sized rows when the capture supports it.
    if (capture.appendThoughtChunk !== undefined) {
      capture.appendThoughtChunk(thought);
    } else {
      capture.recordThought(thought);
    }
  } catch (err) {
    console.warn("stdio-acp: failed to capture agent_thought_chunk", err);
  }
}

// #297: write any buffered thought text of this dispatch as one row.
function flushThoughtCapture(
  capture: StdioAcpThoughtCapture | undefined,
  handoffId: string | undefined,
): void {
  if (capture === undefined || handoffId === undefined) return;
  try {
    capture.flush?.(handoffId);
  } catch (err) {
    console.warn("stdio-acp: failed to flush thought capture", err);
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

// #341: ACP tool_call / tool_call_update payloads carry the arguments in `rawInput` and the
// result in `rawOutput` or a `content` array. `input` / `output` are the older non-spec fields.
export interface AcpToolCallFields {
  content?: unknown;
  input?: unknown;
  output?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export function acpToolCallInput(update: AcpToolCallFields): unknown {
  if (update.rawInput !== undefined) return update.rawInput;
  return update.input;
}

export function acpToolCallOutput(update: AcpToolCallFields): unknown {
  if (update.rawOutput !== undefined) return update.rawOutput;
  if (update.output !== undefined) return update.output;
  const content = update.content;
  return Array.isArray(content) ? (content as unknown[]) : undefined;
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
    toolName: resolveToolName(update, ctx.toolNames),
    status: narrowToolCallStatus(update.status),
    input: acpToolCallInput(update),
  });
  killOnToolCallWhenNoCapability(ctx);
}

function handleToolCallUpdate(ctx: DispatchTurnContext, update: AcpSessionUpdate): void {
  const output = acpToolCallOutput(update);
  const toolName = resolveToolName(update, ctx.toolNames);
  ctx.capturePort?.emit({
    kind: "tool_call_update",
    toolCallId: update.toolCallId,
    toolName,
    status: narrowToolCallStatus(update.status),
    input: acpToolCallInput(update),
    output,
  });
  if (update.status === "failed") {
    emitLifecycle(ctx.input, "agent.tool_call.failed", {
      adapter: "stdio-acp",
      tool_call_id: update.toolCallId,
      tool_name: toolName,
      output: output ?? null,
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
  // #297: any non-thought update ends the buffered thought row.
  if (update.sessionUpdate !== "agent_thought_chunk") {
    flushThoughtCapture(ctx.thoughtCapture, ctx.input.handoff_id);
  }
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      handleAgentMessageChunk(ctx, update);
      break;
    case "agent_thought_chunk":
      ctx.markSegmentBreak();
      handleAgentThoughtChunk(ctx, update);
      break;
    case "tool_call":
      ctx.markSegmentBreak();
      handleToolCall(ctx, update);
      break;
    case "tool_call_update":
      ctx.markSegmentBreak();
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

function emitPrewarmEvictedLifecycle(
  input: DispatchInput,
  event: AcpWarmPoolPrewarmEviction,
): void {
  emitLifecycle(input, "acp.warm_pool.prewarm_evicted", {
    evicted_agent: event.evictedAgent,
    evicted_repo_root: event.evictedRepoRoot,
    depositor_agent: event.depositorAgent,
    idle_ms: event.idleMs,
  });
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
    sandboxProfile?: string,
  ): Promise<{ server: StdioAcpHandle; client: StdioAcpClient }> {
    const server = await this.deps.startServer({
      binary: this.opts.binary,
      args: this.opts.args,
      cwd,
      env: mergedEnv,
      signal,
      sandboxProfile,
    });
    // Begin tracking process liveness as soon as the handle exists. The
    // registry installs the sole `exited` handler, and deferring it until
    // session setup made "is the process still alive" depend on how many
    // awaits happened to precede the first check.
    getOrCreateServerExitRegistry(server);
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

  private buildClientCapabilities(input?: DispatchInput): AcpClientCapabilities {
    return buildClientCapabilities(this.opts, input);
  }

  private maybeDepositWarm(args: {
    server: StdioAcpHandle;
    client: StdioAcpClient;
    authMethods: AcpAuthMethod[];
    warmPoolEnabled: boolean;
    poolKey: string;
    specHash: string;
    input: DispatchInput;
  }): AcpWarmPoolEntry | null {
    if (!args.warmPoolEnabled || !this.deps.pool) return null;
    const entry =
      this.deps.pool.deposit(
        args.poolKey,
        {
          handle: args.server,
          client: args.client,
          authMethods: args.authMethods,
          specHash: args.specHash,
        },
        {
          onReject: "keep",
          onPrewarmEvicted: (event) => {
            emitPrewarmEvictedLifecycle(args.input, event);
          },
        },
      ) ?? null;
    if (entry === null) {
      const meta = {
        adapter: this.kind,
        pool_key: args.poolKey,
        total_entries: this.deps.totalPoolEntryCount?.() ?? totalAcpWarmPoolEntryCount(),
        agent_entries: this.deps.pool.size(),
        cap: resolveWarmPrewarmCap(),
        reason: "rejected",
      };
      console.warn("stdio-acp: warm-pool deposit rejected; continuing un-pooled", meta);
      emitLifecycle(args.input, "acp.warm_pool.deposit_rejected", meta);
    }
    return entry;
  }

  /**
   * Initialize the connection, then deposit the warm connection
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
      prewarm?: boolean;
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
    if (!args.warmPoolEnabled || !this.deps.pool) return null;
    return (
      this.deps.pool.deposit(
        args.poolKey,
        {
          handle: server,
          client,
          authMethods,
          specHash: args.specHash,
          pinned: args.pinned,
          prewarm: args.prewarm,
        },
        { onReject: "kill" },
      ) ?? null
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
        prewarm: true,
        bootDeadline,
      });
      return { deposited: entry !== null, poolKey };
    } catch (err) {
      server.kill();
      throw err;
    }
  }

  private acquireWarm(poolKey: string, specHash: string, holderId: string): WarmAcquire {
    if (this.opts.warmPool !== true || !this.deps.pool) return { entry: null };
    const missReason = this.deps.pool.peekMissReason?.(poolKey, specHash);
    const poolKeys = this.deps.pool.debugKeys?.();
    const entry = this.deps.pool.acquire(holderId, poolKey, specHash);
    return { entry, missReason, poolKeys };
  }

  private async createSession(
    server: StdioAcpHandle,
    client: StdioAcpClient,
    bootDeadline: StdioAcpBootDeadline,
    cwd: string,
    input: DispatchInput,
    mergedEnv: Record<string, string>,
    authMethods: AcpAuthMethod[],
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
    const meta: SessionParamsMeta = buildClaudeCodeMeta(this.opts) ?? {};
    const mode = resolvePermissionMode(this.opts, input);
    if (mode !== undefined) {
      meta.permissionMode = mode;
      meta.permission = { mode };
    }
    if (Object.keys(meta).length > 0) sessionParams._meta = meta;
    let session: AcpSessionNewResponse;
    try {
      session = await this.requestWithBootDeadline<AcpSessionNewResponse>(
        server,
        client,
        bootDeadline,
        "session/new",
        sessionParams,
      );
    } catch (err) {
      if (!isAuthenticationRequiredError(err) || authMethods.length === 0) throw err;
      const chosenAuthId = selectAuthMethodId(authMethods, this.opts.authMethodId, mergedEnv);
      await this.requestWithBootDeadline(server, client, bootDeadline, "authenticate", {
        methodId: chosenAuthId,
      });
      session = await this.requestWithBootDeadline<AcpSessionNewResponse>(
        server,
        client,
        bootDeadline,
        "session/new",
        sessionParams,
      );
    }
    if (this.opts.model !== undefined && this.opts.model.length > 0) {
      await this.applySessionModel(server, client, bootDeadline, session, input);
    }
    return session.sessionId;
  }

  // #328: select options.model through ACP session/set_model when the agent advertises it.
  // A rejected set_model is recorded and the dispatch continues on the agent's default model.
  // A boot-deadline timeout has already killed the server, so it fails the dispatch.
  private async applySessionModel(
    server: StdioAcpHandle,
    client: StdioAcpClient,
    bootDeadline: StdioAcpBootDeadline,
    session: AcpSessionNewResponse,
    input: DispatchInput,
  ): Promise<void> {
    const model = this.opts.model;
    if (model === undefined || model.length === 0) return;
    const meta = { adapter: this.kind, session_id: session.sessionId, model };
    const action = decideSessionModel(model, session.models);
    if (action === "unadvertised" || action === "unlisted") {
      emitLifecycle(input, "acp.model_unavailable", { ...meta, advertised: action === "unlisted" });
      return;
    }
    if (action === "current") {
      emitLifecycle(input, "acp.model_selected", { ...meta, set_model_sent: false });
      return;
    }
    try {
      await this.requestWithBootDeadline(server, client, bootDeadline, "session/set_model", {
        sessionId: session.sessionId,
        modelId: model,
      });
    } catch (err) {
      emitLifecycle(input, "acp.model_select_failed", { ...meta, error: String(err) });
      if (err instanceof Error && err.message.startsWith("stdio-acp: boot timed out")) throw err;
      return;
    }
    emitLifecycle(input, "acp.model_selected", { ...meta, set_model_sent: true });
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

  private cleanupConnection(
    state: DispatchState,
    args: {
      errorThrown: boolean;
      poolKey: string;
      holderId: string;
      warmPoolEnabled: boolean;
    },
  ): void {
    state.permissionContext?.deactivate();
    if (
      args.warmPoolEnabled &&
      state.pooledEntry &&
      !args.errorThrown &&
      !state.warmupTimedOut &&
      this.deps.pool
    ) {
      this.deps.pool.release(args.holderId, args.poolKey);
      return;
    }
    if (args.warmPoolEnabled && state.pooledEntry && this.deps.pool) {
      this.deps.pool.evict(args.poolKey, state.pooledEntry);
    }
    if (state.server && state.pooledEntry?.tornDown !== true) {
      state.server.kill();
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
    // #297: write thought text left over from an earlier turn (the model warmup) as its own row.
    flushThoughtCapture(this.deps.thoughtCapture, args.input.handoff_id);
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
      flushThoughtCapture(this.deps.thoughtCapture, args.input.handoff_id);
      args.state.promptTimeoutRejector = null;
      clearPromptTimer(args.state);
      clearInterval(heartbeatTimer);
      args.lifecycleHandles.detachSessionExitRejection();
    }
  }

  private async *handleDispatchCatch(
    err: unknown,
    state: DispatchState,
    warmPoolEnabled: boolean,
    poolKey: string,
    input: DispatchInput,
  ): AsyncIterable<DispatchEvent> {
    const coldAdapter = input.signal.aborted
      ? null
      : this.prepareColdRetry(err, state, warmPoolEnabled, poolKey);
    if (coldAdapter) {
      for await (const event of coldAdapter.dispatchStream(input)) {
        yield event;
      }
      return;
    }
    augmentDispatchError(err, state.server, resolveFinalResponseText(state).text);
    state.errorThrown = true;
    throw err;
  }

  private bindPooledDispatchAbort(
    signal: AbortSignal,
    state: DispatchState,
    poolKey: string,
    enabled: boolean,
  ): (() => void) | undefined {
    if (!enabled) return undefined;
    const abort = (): void => {
      if (state.pooledEntry && this.deps.pool) {
        this.deps.pool.evict(poolKey, state.pooledEntry);
      } else {
        state.server?.kill();
      }
    };
    // A pooled process outlives its spawning dispatch; bind only its current owner.
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return (): void => {
      signal.removeEventListener("abort", abort);
    };
  }

  async *dispatchStream(input: DispatchInput): AsyncIterable<DispatchEvent> {
    const { dispatchStartTs, cwd, requestTimeoutMs, warmPoolEnabled, poolKey, specHash, holderId } =
      computeDispatchConstants(this.opts, this.deps.pool, input);
    const sandboxProfile = resolveDispatchSandboxProfile(input, cwd);
    const state = createDispatchState();
    let detachAbort: (() => void) | undefined;
    try {
      input.signal.throwIfAborted();
      const mergedEnv = this.buildMergedEnv();
      const bootDeadline = this.createBootDeadline();

      const warm: WarmAcquire = warmPoolEnabled
        ? this.acquireWarm(poolKey, specHash, holderId)
        : { entry: null };
      const signal = warmPoolEnabled ? undefined : input.signal;
      const acquired: AcquireOrSpawnResult = warm.entry
        ? acquireReuseResult(warm.entry, input, this.kind, poolKey, dispatchStartTs)
        : buildSpawnResult({
            spawned: await this.spawnAcpServer(cwd, mergedEnv, signal, sandboxProfile),
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
      detachAbort = this.bindPooledDispatchAbort(input.signal, state, poolKey, warmPoolEnabled);
      input.signal.throwIfAborted();
      let authMethods = acquired.pooledEntry?.authMethods ?? [];

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

      if (!acquired.reusedSession) {
        const initResponse = await this.requestWithBootDeadline<AcpInitializeResponse>(
          server,
          client,
          bootDeadline,
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: this.buildClientCapabilities(input),
            clientInfo: { name: "penumbra", version: "1.0.0" },
          },
        );
        authMethods = initResponse.authMethods ?? [];
        state.pooledEntry = this.maybeDepositWarm({
          server,
          client,
          authMethods,
          warmPoolEnabled,
          poolKey,
          specHash,
          input,
        });
        state.pooledEntry?.refs.add(holderId);
      }

      const createdSessionId = await this.createSession(
        server,
        client,
        bootDeadline,
        cwd,
        input,
        mergedEnv,
        authMethods,
      );
      const sessionId = handleSessionCreated({
        session: { sessionId: createdSessionId },
        adapterKind: this.kind,
        input,
        client,
        state,
        dispatchStartTs,
      });
      const lifecycleHandles = setupServerLifecycleHandles(server, state, turnCtx, sessionId);
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
        resetPromptTurnAccumulators(state);
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
      yield buildDispatchDoneEvent(state, promptResponse, input);
    } catch (err) {
      yield* this.handleDispatchCatch(err, state, warmPoolEnabled, poolKey, input);
    } finally {
      detachAbort?.();
      if (input.handoff_id !== undefined) unregisterSession(input.handoff_id);
      this.cleanupConnection(state, {
        errorThrown: state.errorThrown || input.signal.aborted,
        poolKey,
        holderId,
        warmPoolEnabled,
      });
    }
  }
}

interface MessagePhaseAccum {
  sawPhasedChunk: boolean;
  finalAnswerText: string;
  finalAnswerSegmentBreak: boolean;
}

interface DispatchState {
  server: StdioAcpHandle | null;
  pooledEntry: AcpWarmPoolEntry | null;
  accumulatedText: string;
  segmentBreak: boolean;
  messagePhase: MessagePhaseAccum;
  frameworkOverheadMs: number | undefined;
  errorThrown: boolean;
  warmupTimedOut: boolean;
  promptTimer: ReturnType<typeof setTimeout> | null;
  promptTimeoutRejector: ((err: Error) => void) | null;
  permissionContext: StdioAcpPermissionContext | null;
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
  const permissionContext = new StdioAcpPermissionContext();
  state.permissionContext = permissionContext;
  const context: DispatchTurnContext = {
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
    markSegmentBreak: (): void => {
      state.segmentBreak = true;
      state.messagePhase.finalAnswerSegmentBreak = true;
    },
    accumulate: (text: string, phase?: string): void => {
      state.accumulatedText = appendMessageSegment(state.accumulatedText, text, state.segmentBreak);
      state.segmentBreak = false;
      // codex-acp tags each agent_message_chunk with _meta.codex.phase
      // ("commentary" progress narration vs "final_answer"). Only
      // final_answer chunks count toward the recorded response; unknown
      // future phases are treated as non-final. Chunks with a null/absent
      // phase (normalised to undefined by codexChunkPhase) are deliberately
      // NOT counted here: codex emits phase-less items around tool calls and
      // item lifecycle, so counting them would re-glue noise onto the answer.
      // They still land in accumulatedText, so the no-final_answer fail-open
      // path keeps them — the only case where a phase-less chunk contributes
      // to the response.
      if (phase === undefined) return;
      state.messagePhase.sawPhasedChunk = true;
      if (phase === CODEX_FINAL_ANSWER_PHASE) {
        const phases = state.messagePhase;
        phases.finalAnswerText = appendMessageSegment(
          phases.finalAnswerText,
          text,
          phases.finalAnswerSegmentBreak,
        );
        phases.finalAnswerSegmentBreak = false;
      }
    },
    permissionContext,
    toolNames: new Map<string, string>(),
  };
  registerFsHandlers(context, args.opts);
  registerTerminalHandlers(context, args.opts);
  registerPermissionHandler(context, args.opts);
  return context;
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
  return (
    warmPoolEnabled &&
    pooledEntry !== null &&
    (err instanceof AcpSessionEvictedError || isTransportClosedError(err, pooledEntry))
  );
}

function isTransportClosedError(err: unknown, pooledEntry: AcpWarmPoolEntry): boolean {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve compatibility with lightweight clients that omit transport probes.
  const isTransportOpen = pooledEntry.client.isTransportOpen;
  return (
    (typeof isTransportOpen === "function" && !isTransportOpen.call(pooledEntry.client)) ||
    (err instanceof Error && err.message.includes("stdio-acp-client: transport closed"))
  );
}

interface WarmAcquire {
  entry: AcpWarmPoolEntry | null;
  missReason?: string;
  poolKeys?: string[];
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
    // Permission-profile dispatches never touch the warm pool: prewarmed
    // servers were spawned unsandboxed (before any profile was known), and a
    // sandboxed profile server must not be redeposited for unprofiled reuse.
    warmPoolEnabled:
      opts.warmPool === true &&
      pool !== undefined &&
      (input.permission_profile === undefined || input.permission_profile === null),
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

// Phase state is scoped per prompt turn: it must reset wherever the text
// buffer is cleared, or a previous turn's final_answer leaks into the next
// turn's recorded response.
function resetPromptTurnAccumulators(state: DispatchState): void {
  state.accumulatedText = "";
  state.segmentBreak = false;
  state.messagePhase = {
    sawPhasedChunk: false,
    finalAnswerText: "",
    finalAnswerSegmentBreak: false,
  };
}

function createDispatchState(): DispatchState {
  return {
    server: null,
    pooledEntry: null,
    accumulatedText: "",
    segmentBreak: false,
    messagePhase: { sawPhasedChunk: false, finalAnswerText: "", finalAnswerSegmentBreak: false },
    frameworkOverheadMs: undefined,
    errorThrown: false,
    warmupTimedOut: false,
    promptTimer: null,
    promptTimeoutRejector: null,
    permissionContext: null,
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
  const meta: SessionParamsMeta = buildClaudeCodeMeta(opts) ?? {};
  const mode = resolvePermissionMode(opts, input);
  if (mode !== undefined) {
    meta.permissionMode = mode;
    meta.permission = { mode };
  }
  if (Object.keys(meta).length > 0) params._meta = meta;
  return params;
}

interface ServerLifecycleHandles {
  serverAliveRef: { current: boolean };
  toolUseRejection: { promise: Promise<never>; reject: (err: Error) => void };
  sessionExitRejection: { promise: Promise<never>; reject: (err: Error) => void };
  detachSessionExitRejection: () => void;
}

interface ServerExitRegistry {
  aliveRef: { current: boolean };
  sessionExitRejectors: Set<(err: Error) => void>;
}

// Per-connection registry keyed by the shared server handle. The pool holds a
// warm process across many dispatches (30-min max-age); attaching a fresh
// per-dispatch .then() closure to server.exited retained every dispatch's
// DispatchState (accumulatedText) until process death, growing the retained
// set as O(total dispatches served). The registry installs exactly ONE
// .then() per connection and dispatches into a mutable Set that
// runPromptInteraction empties in its finally block, bounding retained state
// to O(active dispatches).
const serverExitRegistries = new WeakMap<StdioAcpHandle, ServerExitRegistry>();

function getOrCreateServerExitRegistry(server: StdioAcpHandle): ServerExitRegistry {
  const existing = serverExitRegistries.get(server);
  if (existing) return existing;
  const registry: ServerExitRegistry = {
    aliveRef: { current: true },
    sessionExitRejectors: new Set(),
  };
  serverExitRegistries.set(server, registry);
  void server.exited.then((code) => {
    registry.aliveRef.current = false;
    if (code !== 0) {
      for (const reject of registry.sessionExitRejectors) reject(new AcpSessionEvictedError());
      registry.sessionExitRejectors.clear();
    }
  });
  return registry;
}

function setupServerLifecycleHandles(
  server: StdioAcpHandle,
  state: DispatchState,
  turnCtx: DispatchTurnContext,
  sessionId: string,
): ServerLifecycleHandles {
  turnCtx.permissionContext.activate(sessionId);
  const registry = getOrCreateServerExitRegistry(server);
  const toolUseRejection = createRejectablePromise<never>();
  turnCtx.toolUseRejectorRef.current = toolUseRejection.reject;
  const sessionExitRejection = createRejectablePromise<never>();
  const gatedReject = (err: Error): void => {
    if (state.pooledEntry) sessionExitRejection.reject(err);
  };
  registry.sessionExitRejectors.add(gatedReject);
  const detachSessionExitRejection = (): void => {
    registry.sessionExitRejectors.delete(gatedReject);
  };
  return {
    serverAliveRef: registry.aliveRef,
    toolUseRejection,
    sessionExitRejection,
    detachSessionExitRejection,
  };
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
    turnCtx.permissionContext.observe(params.sessionId, update);
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

function resolveFinalResponseText(state: DispatchState): { text: string; drift: boolean } {
  const phases = state.messagePhase;
  if (phases.finalAnswerText.trim().length > 0)
    return { text: phases.finalAnswerText, drift: false };
  // Fail open on the full concatenation when there is no non-whitespace final_answer text.
  return { text: state.accumulatedText, drift: phases.sawPhasedChunk };
}

function buildDispatchDoneEvent(
  state: DispatchState,
  promptResponse: AcpPromptResponse | null,
  input: DispatchInput,
): DispatchEvent {
  const resolved = resolveFinalResponseText(state);
  if (resolved.drift) {
    const handoffId = input.handoff_id ?? input.eventContext?.handoffId ?? "unknown";
    console.warn(
      `stdio-acp: agent_message_chunk carried _meta.codex.phase but no non-whitespace final_answer text; falling back to full concatenation (handoff_id=${handoffId})`,
      { accumulated_len: state.accumulatedText.length },
    );
    emitLifecycle(input, "acp.phase.drift", {
      adapter: "stdio-acp",
      accumulated_len: state.accumulatedText.length,
    });
  }
  const finalText = resolved.text;
  const classifierDecline = detectStdioAcpClassifierDecline({
    finalText,
    errorText: finalText.trim().length === 0 ? JSON.stringify(promptResponse) : null,
  });
  return {
    type: "done",
    result: {
      text: finalText,
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
