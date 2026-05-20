export interface AcpMessagePart {
  type: 'text' | string;
  text?: string;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: number;
  authMethods: string[];
  capabilities?: {
    terminal?: boolean;
    fs?: boolean;
    [key: string]: unknown;
  };
}

export interface SessionNewParams {
  [key: string]: unknown;
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionPromptParams {
  sessionId: string;
  parts: AcpMessagePart[];
}

export interface SessionPromptResult {
  [key: string]: unknown;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionCancelResult {
  [key: string]: unknown;
}
