import type { DispatchEventInput } from "@penumbra/core";

import type { WriteToolsExecutor } from "../worker/write-tools-executor.js";

export interface ToolCallContext {
  toolName: string;
  rawInput: unknown;
  /** Phase 1d — dispatch identity for executor scoping (one-shot terminal registry, audit emit) */
  dispatchId: string;
}

export type PermissionDecision = "approve" | "reject";

export interface DispatchInput {
  prompt: string;
  conversation: { id: string; project_id: string | null };
  config: Record<string, unknown>;
  long_lived_session?: {
    dispatch_kind?: string | null;
    agent_id?: string | null;
    tick_id?: string | null;
    mcp_tool_allowlist?: string[] | null;
  };
  signal: AbortSignal;
  requestPermission?: (toolCall: ToolCallContext) => Promise<PermissionDecision>;
  /**
   * Dispatch trust mode (per-handoff). Adapters use this to fast-path
   * permission auto-approval under trust-all without consulting requestPermission
   * for every nested tool call, and to advertise a permissive permission level
   * during the ACP handshake when the underlying agent supports that hint.
   * Absent on synthetic callers that haven't been plumbed (treat as "config").
   */
  trust_mode?: "all" | "config";
  handoff_id?: string;
  executor?: WriteToolsExecutor;
  eventContext?: { handoffId: string; workerId?: string };
  onEvent?: (event: DispatchEventInput) => void;
}

export interface DispatchOutput {
  text: string;
  meta?: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    tokens_input?: number;
    tokens_cache_read?: number;
    tokens_cache_write?: number;
    raw_response?: unknown;
    framework_overhead_ms?: number;
    classifier_declined?: true;
    decline_reason?: "provider_safety_refusal";
    reasoning_content?: string;
  };
}

export type DispatchEvent =
  | { type: "delta"; text: string }
  | { type: "done"; result: DispatchOutput }
  // Reserved for v2 tool-use plumbing. Adapters do not emit these in v1; the
  // shapes are defined now so adding tool-use later is a non-breaking change.
  | { type: "tool_call"; tool_name: string; args: unknown; call_id: string }
  | { type: "tool_result"; call_id: string; result: unknown }
  | { type: "tool_error"; call_id: string; error: string };

export interface Adapter {
  readonly kind: string;
  dispatch(input: DispatchInput): Promise<DispatchOutput>;
  dispatchStream?(input: DispatchInput): AsyncIterable<DispatchEvent>;
  healthcheck?(): Promise<{ ok: boolean; detail?: string }>;
}
