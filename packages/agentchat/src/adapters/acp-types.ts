/**
 * Agent Client Protocol (ACP) types for OpenCode.
 * Based on OpenCode ACP Implementation Spec (2026-04-27).
 */

export interface AcpSession {
  id: string;
}

export interface AcpCreateSessionRequest {
  cwd?: string;
  parentID?: string;
  title?: string;
  workspaceID?: string;
}

export interface AcpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AcpToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AcpToolResult {
  call_id: string;
  content: string;
}

export interface AcpMessagePart {
  type: "text" | "tool_call" | "tool_result";
  text?: string;
  tool_call?: AcpToolCall;
  tool_result?: AcpToolResult;
}

export interface AcpMessageRequest {
  messageID: string;
  model: string;
  agent: string;
  tools?: AcpTool[];
  parts: AcpMessagePart[];
}

/**
 * `permission.asked` wire properties (opencode Permission.ask). The `per_*`
 * id pairs with the session-scoped respond route and the request-keyed reply
 * route; `sessionID` identifies the session that owns the pending ask.
 */
export interface AcpPermissionAsked {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

/**
 * `permission.v2.asked` wire properties (opencode PermissionV2.ask). Defined
 * alongside the v1 event in opencode 1.18.x; the v2 reply surface lives under
 * the /api-prefixed session permission routes.
 */
export interface AcpPermissionV2Asked {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save: string[];
  metadata: Record<string, unknown>;
  source?: { type: string; messageID?: string; callID?: string };
}

export type AcpEvent =
  | { type: "session.status"; status: string }
  | { type: "lsp.updated"; data: unknown }
  | { type: "message.part.updated"; messageID: string; part: AcpMessagePart }
  | { type: "message.part.delta"; messageID: string; partIndex: number; delta: string }
  | {
      type: "tool.call.requested";
      callID: string;
      tool: string;
      arguments: Record<string, unknown>;
    }
  | { type: "permission.asked"; properties: AcpPermissionAsked }
  | { type: "permission.v2.asked"; properties: AcpPermissionV2Asked }
  | { type: "done" };

export type AcpPermissionReplyKind = "once" | "always" | "reject";

export interface AcpPermissionReply {
  reply: AcpPermissionReplyKind;
  message?: string;
}

export interface AcpPermissionResponse {
  response: AcpPermissionReplyKind;
}

/**
 * ACP-spec types for the `mcpServers` field on session/new.
 * Mirrors @agentclientprotocol/sdk schema/types.gen.d.ts shapes.
 *
 * The discriminated union is:
 *   McpServer = (McpServerHttp & {type:'http'}) | (McpServerSse & {type:'sse'}) | McpServerStdio
 * Stdio is the untagged default - it has no `type` field.
 */
export interface EnvVariable {
  name: string;
  value: string;
}

export interface HttpHeader {
  name: string;
  value: string;
}

export interface McpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}

export interface McpServerHttp {
  type: "http";
  name: string;
  url: string;
  headers: HttpHeader[];
}

export interface McpServerSse {
  type: "sse";
  name: string;
  url: string;
  headers: HttpHeader[];
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;
