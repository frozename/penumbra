import { PERMISSION_PROFILES, type PermissionProfile } from "@penumbra/api-contract";

import { classifyShellArgv, classifyShellCommand } from "./shell-classifier.js";

export { renderOpencodeProfileConfig } from "./opencode-profile.js";
export { renderSandboxExecProfile, resolveSandboxDenyRoots } from "./sandbox-profile.js";
export {
  classifyShellArgv,
  classifyShellCommand,
  type ShellClassifyResult,
} from "./shell-classifier.js";
export { PERMISSION_PROFILES, PermissionProfileSchema } from "@penumbra/api-contract";
export type { PermissionProfile } from "@penumbra/api-contract";

export const PERMISSION_PROFILE_REVIEW_READONLY = "review_readonly" satisfies PermissionProfile;

/**
 * Penumbra MCP tools a review persona may keep under review_readonly.
 * Every entry MUST have readOnly:true in the MCP TOOL_REGISTRY (or be the
 * registry-external read_handle resolver) — pinned by a self-audit test in
 * packages/mcp. The allowlist is injected as PENUMBRA_MCP_TOOL_ALLOWLIST and
 * must never be empty (an empty value registers every tool, see
 * packages/mcp/src/server.ts parseAllowlist).
 */
export const REVIEW_READONLY_MCP_ALLOWLIST: readonly string[] = [
  "memory_search",
  "memory_recall",
  "memory_timeline",
  "memory_get_observations",
  "read_handle",
  "fs_read",
  "fs_glob",
  "fs_grep",
  "handoff_get",
  "chain_list_agents",
];

/**
 * MCP tool allowlist per profile, keyed so a future profile can't silently
 * inherit review_readonly's list. Exhaustive over the closed enum — adding a
 * member without a list is a compile error.
 */
export const PERMISSION_PROFILE_MCP_ALLOWLIST: Record<PermissionProfile, readonly string[]> = {
  [PERMISSION_PROFILE_REVIEW_READONLY]: REVIEW_READONLY_MCP_ALLOWLIST,
};

export interface PermissionProfileSeatLike {
  adapter?: string;
  enforces_permission_profiles?: readonly string[] | null;
}

/**
 * Adapter kinds that enforce a permission profile without seat opt-in.
 * openai-compat-http has no tool surface at all — it cannot mutate anything by
 * construction. opencode-acp delivers the policy through OPENCODE_CONFIG_CONTENT
 * + OPENCODE_DISABLE_PROJECT_CONFIG on every profile dispatch.
 * stdio-acp is intentionally absent: ACP capability advertising does not prove
 * the agent's tool calls actually flow through penumbra's executor (codex and
 * claude run tools natively). Those seats opt in via
 * enforces_permission_profiles in agents.yaml.
 */
const NATIVELY_ENFORCING_ADAPTERS: ReadonlySet<string> = new Set([
  "openai-compat-http",
  "opencode-acp",
]);

/**
 * Whether a seat can enforce the given profile. An explicit
 * enforces_permission_profiles list is authoritative when present (a seat can
 * opt out by setting []). Otherwise the adapter must enforce natively.
 * Unknown agents fail closed — mirroring the privacy hard-constraint rule.
 */
export function agentEnforcesPermissionProfile(
  agent: PermissionProfileSeatLike | undefined | null,
  profile: PermissionProfile,
): boolean {
  if (agent === undefined || agent === null) return false;
  if (
    agent.enforces_permission_profiles !== undefined &&
    agent.enforces_permission_profiles !== null
  ) {
    return agent.enforces_permission_profiles.includes(profile);
  }
  return agent.adapter !== undefined && NATIVELY_ENFORCING_ADAPTERS.has(agent.adapter);
}

/**
 * Every profile at least one seat can enforce — the union a worker declares in
 * its registration metadata (the daemon claim gate refuses profiled handoffs
 * to workers whose declaration misses the handoff's profile).
 */
export function profilesEnforcedBySeats(
  seats: readonly PermissionProfileSeatLike[],
): PermissionProfile[] {
  return PERMISSION_PROFILES.filter((profile) =>
    seats.some((seat) => agentEnforcesPermissionProfile(seat, profile)),
  );
}

export type ProfileToolCallDecision =
  | { decision: "approve" }
  | { decision: "deny"; reason: string };

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "fs.write_text_file",
  "fs_write_text_file",
  "fs/write_text_file",
  "fs.write",
  "fs_write",
  "fs/write",
  "fs.edit",
  "fs_edit",
  "fs/edit",
  "write",
  "write_file",
  "edit",
  "edit_file",
  "apply_patch",
  "str_replace",
]);

const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "terminal.create",
  "terminal_create",
  "terminal/create",
  "fs.exec",
  "fs_exec",
  "fs/exec",
  "shell.run",
  "shell_run",
  "bash",
  "execute",
  "process",
]);

type CommandCandidates = { shells: string[]; argvs: string[][]; malformedArgv: boolean };

// ACP terminal/create-style input carries BOTH a display label (cmd/command)
// and the real argv (args/argv). Classifying only the first non-empty string
// lets {cmd:"ls", argv:["rm","-rf","."]} through — collect every candidate and
// deny when any of them does. A present argv/args key that is not a non-empty
// all-string array is uninspectable rather than absent: silently dropping it
// would let the unclassified vector still reach the executor.
function collectArgvCandidates(input: Record<string, unknown>): {
  argvs: string[][];
  malformed: boolean;
} {
  const argvs: string[][] = [];
  let malformed = false;
  for (const key of ["argv", "args"]) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
      argvs.push(value);
    } else {
      malformed = true;
    }
  }
  return { argvs, malformed };
}

function commandCandidatesFromRawInput(rawInput: unknown): CommandCandidates {
  if (typeof rawInput === "string") {
    return rawInput.length > 0
      ? { shells: [rawInput], argvs: [], malformedArgv: false }
      : { shells: [], argvs: [], malformedArgv: false };
  }
  if (typeof rawInput !== "object" || rawInput === null) {
    return { shells: [], argvs: [], malformedArgv: false };
  }
  const input = rawInput as Record<string, unknown>;
  const shells: string[] = [];
  for (const key of ["cmd", "command", "input", "code"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) shells.push(value);
  }
  const { argvs, malformed } = collectArgvCandidates(input);
  return { shells, argvs, malformedArgv: malformed };
}

function denyReasonForCommandCandidates(candidates: CommandCandidates): string | null {
  for (const shell of candidates.shells) {
    const result = classifyShellCommand(shell);
    if (result.decision === "deny") return result.reason;
  }
  for (const argv of candidates.argvs) {
    const result = classifyShellArgv(argv);
    if (result.decision === "deny") return result.reason;
  }
  return null;
}

function evaluateReviewReadonlyToolCall(
  toolName: string,
  rawInput: unknown,
): ProfileToolCallDecision {
  const normalized = toolName.toLowerCase();
  if (WRITE_TOOL_NAMES.has(normalized)) {
    return { decision: "deny", reason: "review_readonly denies file writes" };
  }
  if (COMMAND_TOOL_NAMES.has(normalized)) {
    const candidates = commandCandidatesFromRawInput(rawInput);
    if (
      candidates.malformedArgv ||
      (candidates.shells.length === 0 && candidates.argvs.length === 0)
    ) {
      return { decision: "deny", reason: "review_readonly: uninspectable command input" };
    }
    const reason = denyReasonForCommandCandidates(candidates);
    if (reason !== null) {
      return { decision: "deny", reason: `review_readonly: ${reason}` };
    }
  }
  return { decision: "approve" };
}

/**
 * Evaluate one gated tool call against a permission profile. Applied by the
 * worker permission callback BEFORE trust_mode, so a profile deny wins over
 * trust 'all'. Unknown tool names fail open — Layer A is a denylist; the
 * sandbox is the write guarantee.
 */
export function evaluateProfileToolCall(
  profile: PermissionProfile,
  toolName: string,
  rawInput: unknown,
): ProfileToolCallDecision {
  void profile;
  return evaluateReviewReadonlyToolCall(toolName, rawInput);
}
