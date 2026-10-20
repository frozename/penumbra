import { evaluateProfileToolCall } from "@penumbra/core";

import type { DispatchInput } from "../sdk/adapter.js";

const MAX_TOOL_CALL_CONTEXTS = 64;
const MAX_RETIRED_TOOL_CALL_IDS = 4096;
const MAX_CONTEXT_STRING_CHARS = 1024;
const MAX_RAW_INPUT_BYTES = 64 * 1024;
const TERMINAL_TOOL_CALL_STATUSES = new Set(["canceled", "cancelled", "completed", "failed"]);

export interface AcpPermissionToolCallContext {
  name?: unknown;
  rawInput?: unknown;
  title?: unknown;
  toolCallId?: unknown;
}

export interface AcpPermissionRequestContext {
  sessionId?: unknown;
  toolCall?: AcpPermissionToolCallContext;
}

export interface AcpPermissionRequest extends AcpPermissionRequestContext {
  options?: unknown;
}

export interface PermissionResultCancelled {
  outcome: { outcome: "cancelled" };
}

export interface PermissionResultSelected {
  outcome: { optionId: string; outcome: "selected" };
}

export type PermissionResult = PermissionResultCancelled | PermissionResultSelected;

export interface AcpPermissionToolCallUpdate {
  input?: unknown;
  name?: unknown;
  rawInput?: unknown;
  sessionUpdate?: unknown;
  status?: unknown;
  title?: unknown;
  toolCallId?: unknown;
}

export interface ResolvedPermissionContext {
  decisionToken: symbol;
  rawInput: unknown;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}

interface RetainedToolCallContext {
  hasRawInput: boolean;
  name?: string;
  rawInput?: unknown;
  title?: string;
}

interface RetainedRawInput {
  retained: boolean;
  value?: unknown;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cancelledOutcome(): PermissionResultCancelled {
  return { outcome: { outcome: "cancelled" } };
}

interface PermissionOption {
  kind?: unknown;
  optionId?: unknown;
}

function permissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (option): option is PermissionOption =>
      typeof option === "object" && option !== null && !Array.isArray(option),
  );
}

function isBypassOptionId(optionId: unknown): boolean {
  // eslint-disable-next-line regexp/no-unused-capturing-group -- Preserve the established trust-all policy expression.
  return typeof optionId === "string" && /^(switch_)?bypass$/i.test(optionId);
}

function isBypassLikeOptionId(optionId: unknown): boolean {
  return typeof optionId === "string" && /bypass/i.test(optionId);
}

function pickPermissionOption(
  options: PermissionOption[],
  predicates: ((option: PermissionOption) => boolean)[],
): PermissionOption | undefined {
  for (const predicate of predicates) {
    const found = options.find((option) => predicate(option));
    if (found !== undefined) return found;
  }
  return undefined;
}

function selectTrustAllOption(options: PermissionOption[]): PermissionOption | undefined {
  return pickPermissionOption(options, [
    (option): boolean => option.kind === "allow_always" && isBypassOptionId(option.optionId),
    (option): boolean => option.kind === "allow_always" && !isBypassLikeOptionId(option.optionId),
    (option): boolean => option.kind === "allow_always",
    (option): boolean => option.kind === "allow_once",
    (): boolean => true,
  ]);
}

function selectConfigOption(
  options: PermissionOption[],
  decision: "approve" | "reject",
): PermissionOption | undefined {
  if (decision === "approve") {
    return options.find(
      (option) =>
        option.kind === "allow_once" &&
        typeof option.optionId === "string" &&
        !isBypassLikeOptionId(option.optionId),
    );
  }
  return options.find(
    (option) => option.kind === "reject_once" && typeof option.optionId === "string",
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CONTEXT_STRING_CHARS
    ? value
    : undefined;
}

function retainRawInput(value: unknown): RetainedRawInput {
  try {
    const serialized: unknown = JSON.stringify(value);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > MAX_RAW_INPUT_BYTES
    ) {
      return { retained: false };
    }
    return { retained: true, value: JSON.parse(serialized) as unknown };
  } catch {
    return { retained: false };
  }
}

function mergeStringField(
  target: RetainedToolCallContext,
  source: AcpPermissionToolCallContext,
  key: "name" | "title",
): void {
  if (!hasOwn(source, key)) return;
  const value = nonEmptyString(source[key]);
  if (value === undefined) target[key] = undefined;
  else target[key] = value;
}

function mergeRawInput(
  target: RetainedToolCallContext,
  source: AcpPermissionToolCallContext | AcpPermissionToolCallUpdate,
): void {
  const key = hasOwn(source, "rawInput") ? "rawInput" : hasOwn(source, "input") ? "input" : null;
  if (key === null) return;
  const value =
    key === "rawInput" ? source.rawInput : (source as AcpPermissionToolCallUpdate).input;
  const retained = retainRawInput(value);
  target.hasRawInput = retained.retained;
  if (retained.retained) target.rawInput = retained.value;
  else delete target.rawInput;
}

function mergedRequestField(
  request: AcpPermissionToolCallContext,
  retained: RetainedToolCallContext,
  key: "name" | "title",
): string | undefined {
  return hasOwn(request, key) ? nonEmptyString(request[key]) : retained[key];
}

export class StdioAcpPermissionContext {
  private activeSessionId: string | null = null;
  private readonly pendingDecisions = new Map<string, symbol>();
  private readonly retiredToolCallIds = new Set<string>();
  private retirementOverflowed = false;
  private readonly toolCalls = new Map<string, RetainedToolCallContext>();

  activate(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.toolCalls.clear();
    this.pendingDecisions.clear();
    this.retiredToolCallIds.clear();
    this.retirementOverflowed = false;
  }

  deactivate(): void {
    this.activeSessionId = null;
    this.toolCalls.clear();
    this.pendingDecisions.clear();
    this.retiredToolCallIds.clear();
    this.retirementOverflowed = false;
  }

  matchesActiveSession(sessionId: unknown): boolean {
    return typeof sessionId === "string" && sessionId === this.activeSessionId;
  }

  observe(sessionId: unknown, update: AcpPermissionToolCallUpdate): void {
    if (!this.matchesActiveSession(sessionId)) return;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const toolCallId = nonEmptyString(update.toolCallId);
    if (toolCallId === undefined) return;
    if (TERMINAL_TOOL_CALL_STATUSES.has(update.status as string)) {
      this.toolCalls.delete(toolCallId);
      this.pendingDecisions.delete(toolCallId);
      this.retire(toolCallId);
      return;
    }
    if (this.retirementOverflowed || this.retiredToolCallIds.has(toolCallId)) return;

    const retained =
      update.sessionUpdate === "tool_call"
        ? { hasRawInput: false }
        : (this.toolCalls.get(toolCallId) ?? { hasRawInput: false });
    mergeStringField(retained, update, "title");
    mergeStringField(retained, update, "name");
    mergeRawInput(retained, update);
    this.toolCalls.delete(toolCallId);
    this.toolCalls.set(toolCallId, retained);
    while (this.toolCalls.size > MAX_TOOL_CALL_CONTEXTS) {
      const oldest = this.toolCalls.keys().next().value;
      if (oldest === undefined) break;
      this.toolCalls.delete(oldest);
    }
  }

  resolve(request: AcpPermissionRequestContext): ResolvedPermissionContext | null {
    if (!this.matchesActiveSession(request.sessionId)) return null;
    const toolCall = request.toolCall;
    if (!toolCall || typeof toolCall !== "object") return null;
    const toolCallId = nonEmptyString(toolCall.toolCallId);
    if (toolCallId === undefined) return null;
    if (this.retirementOverflowed || this.retiredToolCallIds.has(toolCallId)) return null;
    const retained = this.toolCalls.get(toolCallId) ?? { hasRawInput: false };
    this.toolCalls.delete(toolCallId);

    const title = mergedRequestField(toolCall, retained, "title");
    const name = mergedRequestField(toolCall, retained, "name");
    const toolName = title ?? name;
    const requestRawInput = hasOwn(toolCall, "rawInput")
      ? retainRawInput(toolCall.rawInput)
      : { retained: retained.hasRawInput, value: retained.rawInput };
    if (!this.retire(toolCallId)) return null;
    if (toolName === undefined || !requestRawInput.retained) return null;
    const decisionToken = Symbol(toolCallId);
    this.pendingDecisions.set(toolCallId, decisionToken);
    return {
      decisionToken,
      rawInput: requestRawInput.value,
      sessionId: request.sessionId as string,
      toolCallId,
      toolName,
    };
  }

  finishDecision(permissionContext: ResolvedPermissionContext): boolean {
    const isCurrent =
      this.matchesActiveSession(permissionContext.sessionId) &&
      this.pendingDecisions.get(permissionContext.toolCallId) === permissionContext.decisionToken;
    this.pendingDecisions.delete(permissionContext.toolCallId);
    return isCurrent;
  }

  private retire(toolCallId: string): boolean {
    if (this.retirementOverflowed) return false;
    if (this.retiredToolCallIds.has(toolCallId)) return true;
    if (this.retiredToolCallIds.size >= MAX_RETIRED_TOOL_CALL_IDS) {
      // Losing an old identity could authorize its reuse, so overflow retires the whole session.
      this.retirementOverflowed = true;
      this.retiredToolCallIds.clear();
      this.toolCalls.clear();
      this.pendingDecisions.clear();
      return false;
    }
    this.retiredToolCallIds.add(toolCallId);
    return true;
  }
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function rejectOrCancelOutcome(options: PermissionOption[]): PermissionResult {
  const chosen = selectConfigOption(options, "reject");
  return typeof chosen?.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
    : cancelledOutcome();
}

// A permission profile evaluates BEFORE trust_mode: a profile deny must win
// over the trust-all fast path, which otherwise picks an allow option without
// ever consulting requestPermission. Unresolvable context and profile denies
// both select reject_once (cancelled when the agent offers no reject option —
// still not an approval). Returns the resolved context on approve so the
// config path can reuse it; "rejected" means an outcome was already decided.
function resolveProfileGate(
  input: DispatchInput,
  context: StdioAcpPermissionContext,
  request: AcpPermissionRequest,
  options: PermissionOption[],
): { context: ResolvedPermissionContext | null; outcome: PermissionResult | null } {
  const profile = input.permission_profile ?? null;
  if (profile === null) return { context: null, outcome: null };
  const permissionContext = context.resolve(request);
  if (permissionContext === null) {
    return { context: null, outcome: rejectOrCancelOutcome(options) };
  }
  const profileDecision = evaluateProfileToolCall(
    profile,
    permissionContext.toolName,
    permissionContext.rawInput,
  );
  if (profileDecision.decision === "deny") {
    context.finishDecision(permissionContext);
    return { context: null, outcome: rejectOrCancelOutcome(options) };
  }
  return { context: permissionContext, outcome: null };
}

export async function handleStdioAcpPermissionRequest(
  input: DispatchInput,
  context: StdioAcpPermissionContext,
  wireRequest: unknown,
): Promise<PermissionResult> {
  if (typeof wireRequest !== "object" || wireRequest === null || Array.isArray(wireRequest)) {
    return cancelledOutcome();
  }
  const request = wireRequest as AcpPermissionRequest;
  if (isSignalAborted(input.signal) || !context.matchesActiveSession(request.sessionId)) {
    return cancelledOutcome();
  }
  const options = permissionOptions(request.options);
  const profileGate = resolveProfileGate(input, context, request, options);
  if (profileGate.outcome !== null) return profileGate.outcome;
  return await resolvePermissionOutcome(input, context, request, options, profileGate.context);
}

async function resolvePermissionOutcome(
  input: DispatchInput,
  context: StdioAcpPermissionContext,
  request: AcpPermissionRequest,
  options: PermissionOption[],
  resolvedContext: ResolvedPermissionContext | null,
): Promise<PermissionResult> {
  if (input.trust_mode === "all") {
    // A resolved-but-profile-approved context is retired here; it was resolved
    // only for profile evaluation and no requestPermission round-trip follows.
    if (resolvedContext !== null) context.finishDecision(resolvedContext);
    const chosen = selectTrustAllOption(options);
    return typeof chosen?.optionId === "string"
      ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
      : cancelledOutcome();
  }
  if (!input.requestPermission) {
    if (resolvedContext !== null) context.finishDecision(resolvedContext);
    return cancelledOutcome();
  }
  const permissionContext = resolvedContext ?? context.resolve(request);
  if (permissionContext === null) return cancelledOutcome();

  let decision: "approve" | "reject" = "approve";
  try {
    decision = await input.requestPermission({
      toolName: permissionContext.toolName,
      rawInput: permissionContext.rawInput,
      dispatchId: input.handoff_id ?? input.conversation.id,
    });
  } catch (err) {
    console.warn("stdio-acp: permission request failed; rejecting", {
      toolName: permissionContext.toolName,
      err: String(err),
    });
    decision = "reject";
  }
  const decisionIsCurrent = context.finishDecision(permissionContext);
  if (isSignalAborted(input.signal) || !decisionIsCurrent) return cancelledOutcome();
  const chosen = selectConfigOption(options, decision);
  return typeof chosen?.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
    : cancelledOutcome();
}
