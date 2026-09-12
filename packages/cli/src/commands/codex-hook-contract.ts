export type CodexHookRole = "maestro" | "dispatch" | "unknown";
export type CodexHookProvenance = "verified-launch" | "verified-session-correlation" | "unknown";
export type CodexHookLineage = "root" | "child" | "unknown";
export type CodexHookToolActivity = "edit" | "shell" | "fleet-dispatch" | "mcp-observe" | "other";

export interface CodexHookLaunchContext {
  role: CodexHookRole;
  rootSessionId: string | null;
  provenance: CodexHookProvenance;
}

export interface NormalizedCodexHook {
  harness: "codex";
  role: CodexHookRole;
  lineage: CodexHookLineage;
  provenance: CodexHookProvenance;
  sessionId: string | null;
  parentSessionId: string | null;
  agentId: string | null;
  agentType: string | null;
  isChild: boolean;
  actionableLifecycle: boolean;
  event: CodexHookEventName;
  cwd: string;
  transcriptPath: string | null;
  transcriptFormat: string | null;
  source: string | null;
  turnId: string | null;
  toolUseId: string | null;
  deliveryId: string | null;
  rawToolName: string | null;
  rawToolInput: unknown;
  toolActivity: CodexHookToolActivity;
}

type CodexHookEventName =
  | "SessionStart"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "SessionEnd";

const KNOWN_EVENTS = new Set<CodexHookEventName>([
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SessionEnd",
]);

const MAX_FIELD_LENGTH = 8192;
const SESSION_START_SOURCES = new Set(["startup", "resume", "clear", "compact"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);
const COMMON_INPUT_FIELDS = [
  "session_id",
  "transcript_path",
  "cwd",
  "hook_event_name",
  "model",
] as const;
const PERMISSION_MODE_EVENTS = new Set<CodexHookEventName>([
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreToolUse",
  "PostToolUse",
]);
const EVENT_INPUT_FIELDS = {
  SessionStart: ["source"],
  SubagentStart: ["turn_id", "agent_id", "agent_type"],
  SubagentStop: [
    "turn_id",
    "agent_id",
    "agent_type",
    "agent_transcript_path",
    "stop_hook_active",
    "last_assistant_message",
  ],
  Stop: ["turn_id", "stop_hook_active", "last_assistant_message"],
  PreToolUse: ["turn_id", "tool_name", "tool_use_id", "tool_input"],
  PostToolUse: ["turn_id", "tool_name", "tool_use_id", "tool_input", "tool_response"],
  PreCompact: ["turn_id", "trigger"],
  SessionEnd: ["reason"],
} as const satisfies Record<CodexHookEventName, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  if (value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value);
}

function optionalNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  if (value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function hookEventName(value: unknown): CodexHookEventName | null {
  const name = boundedString(value);
  if (!name || !KNOWN_EVENTS.has(name as CodexHookEventName)) return null;
  return name as CodexHookEventName;
}

function isChildEvent(event: CodexHookEventName): boolean {
  return event === "SubagentStart" || event === "SubagentStop";
}

function hasValidPermissionMode(raw: Record<string, unknown>): boolean {
  return typeof raw.permission_mode === "string" && PERMISSION_MODES.has(raw.permission_mode);
}

function hasRequiredNullableString(raw: Record<string, unknown>, field: string): boolean {
  if (!(field in raw)) return false;
  const value = raw[field];
  return value === null || (typeof value === "string" && value.length <= MAX_FIELD_LENGTH);
}

function hasOptionalNullableString(raw: Record<string, unknown>, field: string): boolean {
  if (!(field in raw)) return true;
  const value = raw[field];
  return value === null || (typeof value === "string" && value.length <= MAX_FIELD_LENGTH);
}

function hasBoolean(raw: Record<string, unknown>, field: string): boolean {
  return typeof raw[field] === "boolean";
}

function hasKnownInputFields(event: CodexHookEventName, raw: Record<string, unknown>): boolean {
  const allowed = new Set<string>([
    ...COMMON_INPUT_FIELDS,
    ...EVENT_INPUT_FIELDS[event],
    ...(PERMISSION_MODE_EVENTS.has(event) ? ["permission_mode"] : []),
  ]);
  return Object.keys(raw).every((key) => {
    return allowed.has(key) || (key === "transcript_format" && raw[key] === null);
  });
}

function hasEventSpecificFields(event: CodexHookEventName, raw: Record<string, unknown>): boolean {
  switch (event) {
    case "SessionStart":
      return (
        hasValidPermissionMode(raw) &&
        typeof raw.source === "string" &&
        SESSION_START_SOURCES.has(raw.source)
      );
    case "SubagentStart":
      return hasValidPermissionMode(raw) && Boolean(boundedString(raw.turn_id));
    case "SubagentStop":
      return (
        hasValidPermissionMode(raw) &&
        Boolean(boundedString(raw.turn_id)) &&
        hasOptionalNullableString(raw, "agent_transcript_path") &&
        hasBoolean(raw, "stop_hook_active") &&
        hasOptionalNullableString(raw, "last_assistant_message")
      );
    case "Stop":
      return (
        hasValidPermissionMode(raw) &&
        Boolean(boundedString(raw.turn_id)) &&
        hasBoolean(raw, "stop_hook_active") &&
        hasOptionalNullableString(raw, "last_assistant_message")
      );
    case "PreToolUse":
      return (
        hasValidPermissionMode(raw) &&
        Boolean(boundedString(raw.turn_id)) &&
        Boolean(boundedString(raw.tool_name)) &&
        Boolean(boundedString(raw.tool_use_id)) &&
        "tool_input" in raw
      );
    case "PostToolUse":
      return (
        hasValidPermissionMode(raw) &&
        Boolean(boundedString(raw.turn_id)) &&
        Boolean(boundedString(raw.tool_name)) &&
        Boolean(boundedString(raw.tool_use_id)) &&
        "tool_input" in raw &&
        "tool_response" in raw
      );
    case "PreCompact":
      return (
        Boolean(boundedString(raw.turn_id)) && (raw.trigger === "manual" || raw.trigger === "auto")
      );
    case "SessionEnd":
      return raw.reason === "other";
  }
}

function classifyObservedTool(toolName: string | null): CodexHookToolActivity {
  if (!toolName) return "other";
  if (toolName === "apply_patch") return "edit";
  if (toolName === "Bash" || toolName === "shell" || toolName === "exec_command") return "shell";
  if (toolName === "mcp__penumbra__chain_start") return "fleet-dispatch";
  if (toolName === "mcp__penumbra__memory_observe") return "mcp-observe";
  if (toolName === "write_stdin") return "other";
  return "other";
}

function normalizedLineage(
  event: CodexHookEventName,
  rawSessionId: string,
  launch: CodexHookLaunchContext,
): CodexHookLineage {
  if (isChildEvent(event)) return "child";
  if (
    launch.provenance !== "unknown" &&
    launch.rootSessionId !== null &&
    launch.rootSessionId === rawSessionId
  ) {
    return "root";
  }
  return "unknown";
}

export function normalizeCodexHook(
  raw: unknown,
  launch: CodexHookLaunchContext,
): NormalizedCodexHook | null {
  if (!isRecord(raw)) return null;
  const event = hookEventName(raw.hook_event_name);
  if (!event) return null;

  const cwd = boundedString(raw.cwd);
  const rawSessionId = boundedString(raw.session_id);
  const model = boundedString(raw.model);
  if (!cwd || !rawSessionId || !model) return null;
  if (!hasKnownInputFields(event, raw)) return null;
  if (!hasRequiredNullableString(raw, "transcript_path")) return null;
  if (!hasEventSpecificFields(event, raw)) return null;

  const isChild = isChildEvent(event);
  const lineage = normalizedLineage(event, rawSessionId, launch);
  const role: CodexHookRole = lineage === "unknown" ? "unknown" : launch.role;
  const stopHookActive = raw.stop_hook_active === true;
  const toolName = optionalString(raw.tool_name);
  const agentId = optionalString(raw.agent_id);
  const agentType = optionalString(raw.agent_type);

  if (isChild && (!agentId || !agentType)) return null;

  return {
    harness: "codex",
    role,
    lineage,
    provenance: launch.provenance,
    sessionId: isChild ? null : rawSessionId,
    parentSessionId: isChild ? rawSessionId : null,
    agentId,
    agentType,
    isChild,
    actionableLifecycle: role === "maestro" && lineage === "root" && !stopHookActive,
    event,
    cwd,
    transcriptPath: optionalNullableString(raw.transcript_path),
    transcriptFormat: null,
    source: optionalString(raw.source),
    turnId: optionalString(raw.turn_id),
    toolUseId: optionalString(raw.tool_use_id),
    deliveryId: null,
    rawToolName: toolName,
    rawToolInput: raw.tool_input,
    toolActivity: classifyObservedTool(toolName),
  };
}

export function renderCodexHookOutput(event: string, additionalContext: string | null): string {
  const context = boundedString(additionalContext);
  const output =
    event === "SessionStart" && context
      ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }
      : {};
  return `${JSON.stringify(output)}\n`;
}
