// packages/agentchat/src/sdk/adapter.ts
export interface DispatchInput {
  prompt: string;
  conversation: { id: string; project_id: string | null };
  config: Record<string, unknown>;
  signal: AbortSignal;
}

export interface DispatchOutput {
  text: string;
  meta?: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    raw_response?: unknown;
  };
}

export type DispatchEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: DispatchOutput };

export interface Adapter {
  readonly kind: string;
  dispatch(input: DispatchInput): Promise<DispatchOutput>;
  dispatchStream?(input: DispatchInput): AsyncIterable<DispatchEvent>;
  healthcheck?(): Promise<{ ok: boolean; detail?: string }>;
}
