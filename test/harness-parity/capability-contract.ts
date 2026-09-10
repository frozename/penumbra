import { isAbsolute } from "node:path";
import { z } from "zod";

const FixtureSchema = z
  .object({
    surface: z.enum(["cli", "desktop"]),
    build: z.string().nullable(),
    capability: z.string().min(1),
    state: z.enum(["supported", "unavailable", "unknown"]),
    evidence: z.object({
      kind: z.enum(["contract", "live"]),
      surface: z.enum(["cli", "desktop"]),
      source: z.string().trim().min(1),
      observedAt: z.string().trim().min(1),
      probeId: z.string().min(1).nullable(),
    }),
    input: z.record(z.string(), z.unknown()).optional(),
    identity: z
      .object({
        role: z.enum(["root", "child", "dispatch", "unknown"]),
        sessionId: z.string(),
        projectCwd: z.string(),
        agentId: z.string().min(1).nullable(),
      })
      .optional(),
  })
  .strict();

export type CapabilityFixture = z.infer<typeof FixtureSchema>;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") fail("invalid_hook_output");
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") fail("invalid_hook_output");
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("unsupported_hook_output_field");
  }
}

function assertInputKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("unsupported_hook_input_field");
  }
}

function assertHookSpecificOutput(event: string, value: unknown, allowed: readonly string[]): void {
  if (!isRecord(value)) fail("invalid_hook_output");
  assertKeys(value, ["hookEventName", ...allowed]);
  if (value.hookEventName !== event) fail("hook_event_name_mismatch");
  if ("additionalContext" in value) assertString(value.additionalContext);
  if ("permissionDecisionReason" in value) assertString(value.permissionDecisionReason);
  if ("permissionDecision" in value) {
    if (value.permissionDecision !== "allow" && value.permissionDecision !== "deny") {
      fail("invalid_hook_output");
    }
  }
  if ("updatedInput" in value) {
    if (value.permissionDecision !== "allow" || !isRecord(value.updatedInput)) {
      fail("invalid_hook_output");
    }
  }
}

function assertCommonOutput(value: Record<string, unknown>): void {
  if ("continue" in value) assertBoolean(value.continue);
  if ("stopReason" in value) assertString(value.stopReason);
  if ("systemMessage" in value) assertString(value.systemMessage);
  if ("suppressOutput" in value) assertBoolean(value.suppressOutput);
}

const HookInputFields = {
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
} as const;

type HookEvent = keyof typeof HookInputFields;

const CommonHookInputFields = ["session_id", "transcript_path", "cwd", "hook_event_name", "model"];

const PermissionModeEvents = new Set<HookEvent>([
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreToolUse",
  "PostToolUse",
]);

function isHookEvent(value: string): value is HookEvent {
  return value in HookInputFields;
}

function assertRequiredInputString(input: Record<string, unknown>, field: string): void {
  if (!isNonblankString(input[field])) fail("missing_hook_input_field");
}

function assertNullableInputString(input: Record<string, unknown>, field: string): void {
  if (field in input && input[field] !== null && typeof input[field] !== "string") {
    fail("invalid_hook_input");
  }
}

function assertRequiredNullableInputString(input: Record<string, unknown>, field: string): void {
  if (!(field in input)) fail("missing_hook_input_field");
  assertNullableInputString(input, field);
}

function assertPermissionMode(input: Record<string, unknown>): void {
  if (!("permission_mode" in input)) fail("missing_hook_input_field");
  if (
    input.permission_mode !== "default" &&
    input.permission_mode !== "acceptEdits" &&
    input.permission_mode !== "plan" &&
    input.permission_mode !== "dontAsk" &&
    input.permission_mode !== "bypassPermissions"
  ) {
    fail("invalid_hook_input");
  }
}

function assertHookInput(event: HookEvent, input: Record<string, unknown>): void {
  assertInputKeys(input, [
    ...CommonHookInputFields,
    ...HookInputFields[event],
    ...(PermissionModeEvents.has(event) ? ["permission_mode"] : []),
  ]);
  assertRequiredInputString(input, "session_id");
  assertRequiredInputString(input, "cwd");
  assertRequiredInputString(input, "hook_event_name");
  assertRequiredNullableInputString(input, "transcript_path");
  assertRequiredInputString(input, "model");
  if (PermissionModeEvents.has(event)) assertPermissionMode(input);

  switch (event) {
    case "SessionStart":
      if (
        input.source !== "startup" &&
        input.source !== "resume" &&
        input.source !== "clear" &&
        input.source !== "compact"
      ) {
        fail("invalid_hook_input");
      }
      return;
    case "SubagentStart":
      assertRequiredInputString(input, "turn_id");
      assertRequiredInputString(input, "agent_id");
      assertRequiredInputString(input, "agent_type");
      return;
    case "SubagentStop":
      assertRequiredInputString(input, "turn_id");
      assertRequiredInputString(input, "agent_id");
      assertRequiredInputString(input, "agent_type");
      assertNullableInputString(input, "agent_transcript_path");
      assertBoolean(input.stop_hook_active);
      assertNullableInputString(input, "last_assistant_message");
      return;
    case "Stop":
      assertRequiredInputString(input, "turn_id");
      assertBoolean(input.stop_hook_active);
      assertNullableInputString(input, "last_assistant_message");
      return;
    case "PreToolUse":
      assertRequiredInputString(input, "turn_id");
      assertRequiredInputString(input, "tool_name");
      assertRequiredInputString(input, "tool_use_id");
      if (!("tool_input" in input)) fail("missing_hook_input_field");
      return;
    case "PostToolUse":
      assertRequiredInputString(input, "turn_id");
      assertRequiredInputString(input, "tool_name");
      assertRequiredInputString(input, "tool_use_id");
      if (!("tool_input" in input) || !("tool_response" in input)) fail("missing_hook_input_field");
      return;
    case "PreCompact":
      assertRequiredInputString(input, "turn_id");
      if (input.trigger !== "manual" && input.trigger !== "auto") fail("invalid_hook_input");
      return;
    case "SessionEnd":
      if (input.reason !== "other") fail("invalid_hook_input");
      return;
  }
}

function assertBlockDecision(value: Record<string, unknown>): void {
  if ("decision" in value && value.decision !== "block") fail("invalid_hook_output");
  if ("reason" in value) assertString(value.reason);
}

export function parseCapabilityFixture(raw: unknown): CapabilityFixture {
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) fail("invalid_capability_fixture");
  const fixture = parsed.data;

  if (fixture.evidence.surface !== fixture.surface) fail("evidence_surface_mismatch");
  if (fixture.state === "supported" || fixture.state === "unavailable") {
    if (fixture.evidence.kind !== "live") fail("live_evidence_required");
    if (!isNonblankString(fixture.build) || !isNonblankString(fixture.evidence.probeId)) {
      fail("live_evidence_required");
    }
  }

  if (fixture.input && !fixture.identity) fail("session_identity_required");
  if (fixture.identity) {
    const { identity } = fixture;
    if (!identity.sessionId) fail("session_identity_required");
    if (!isAbsolute(identity.projectCwd)) fail("project_identity_required");
    if (identity.role === "child" && !identity.agentId) fail("child_identity_required");

    if (fixture.input) {
      const eventName = fixture.input.hook_event_name;
      if (!isNonblankString(eventName) || eventName !== fixture.capability) {
        fail("hook_capability_mismatch");
      }
      if (!isHookEvent(eventName)) fail("unsupported_hook_event");
      if (
        (eventName === "SubagentStart" || eventName === "SubagentStop") &&
        (identity.role !== "child" ||
          !identity.agentId ||
          fixture.input.agent_id !== identity.agentId)
      ) {
        fail("child_identity_required");
      }
      assertHookInput(eventName, fixture.input);
      if (fixture.input.session_id !== identity.sessionId) fail("session_identity_required");
      if (fixture.input.cwd !== identity.projectCwd) fail("project_identity_required");
    }
  }

  return fixture;
}

export function assertHookOutput(event: string, output: unknown): void {
  if (!isRecord(output)) fail("invalid_hook_output");

  switch (event) {
    case "SessionStart":
      assertKeys(output, [
        "continue",
        "stopReason",
        "systemMessage",
        "suppressOutput",
        "hookSpecificOutput",
      ]);
      assertCommonOutput(output);
      if ("hookSpecificOutput" in output) {
        assertHookSpecificOutput("SessionStart", output.hookSpecificOutput, ["additionalContext"]);
      }
      return;
    case "PreToolUse":
      assertKeys(output, ["systemMessage", "decision", "reason", "hookSpecificOutput"]);
      if ("systemMessage" in output) assertString(output.systemMessage);
      assertBlockDecision(output);
      if ("hookSpecificOutput" in output) {
        assertHookSpecificOutput("PreToolUse", output.hookSpecificOutput, [
          "additionalContext",
          "permissionDecision",
          "permissionDecisionReason",
          "updatedInput",
        ]);
      }
      return;
    case "PreCompact":
      assertKeys(output, ["continue", "stopReason", "systemMessage", "suppressOutput"]);
      assertCommonOutput(output);
      return;
    case "PostToolUse":
      assertKeys(output, [
        "continue",
        "stopReason",
        "systemMessage",
        "decision",
        "reason",
        "hookSpecificOutput",
      ]);
      if ("continue" in output) assertBoolean(output.continue);
      if ("stopReason" in output) assertString(output.stopReason);
      if ("systemMessage" in output) assertString(output.systemMessage);
      assertBlockDecision(output);
      if ("hookSpecificOutput" in output) {
        assertHookSpecificOutput("PostToolUse", output.hookSpecificOutput, ["additionalContext"]);
      }
      return;
    case "SubagentStop":
      assertKeys(output, [
        "continue",
        "stopReason",
        "systemMessage",
        "suppressOutput",
        "decision",
        "reason",
      ]);
      assertCommonOutput(output);
      assertBlockDecision(output);
      return;
    case "Stop":
      assertKeys(output, [
        "continue",
        "stopReason",
        "systemMessage",
        "suppressOutput",
        "decision",
        "reason",
      ]);
      assertCommonOutput(output);
      assertBlockDecision(output);
      return;
    case "SessionEnd":
      assertKeys(output, []);
      return;
    default:
      fail("unsupported_hook_event");
  }
}
