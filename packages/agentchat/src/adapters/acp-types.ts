/**
 * Agent Client Protocol (ACP) types for OpenCode.
 * Based on OpenCode ACP Implementation Spec (2026-04-27).
 */

export interface AcpSession {
  id: string;
}

export interface AcpCreateSessionRequest {
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
  type: 'text' | 'tool_call' | 'tool_result';
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

export type AcpEvent =
  | { type: 'session.status'; status: string }
  | { type: 'lsp.updated'; data: unknown }
  | { type: 'message.part.updated'; messageID: string; part: AcpMessagePart }
  | { type: 'message.part.delta'; messageID: string; partIndex: number; delta: string }
  | { type: 'permission.request'; requestID: string; permission: unknown }
  | { type: 'done' };

export interface AcpPermissionReply {
  reply: 'allow' | 'deny';
  message?: string;
}

export interface AcpPermissionResponse {
  response: Record<string, unknown>;
}
