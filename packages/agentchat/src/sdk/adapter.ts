export interface ToolCallContext {
  toolName: string;
  rawInput: unknown;
  /** Phase 1d — dispatch identity for executor scoping (one-shot terminal registry, audit emit) */
  dispatchId: string;
}

import type { WriteToolsExecutor } from "../worker/write-tools-executor.js";
import type { DispatchEventInput } from "@penumbra/core";

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
    raw_response?: unknown;
    framework_overhead_ms?: number;
    classifier_declined?: true;
    decline_reason?: "provider_safety_refusal";
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
