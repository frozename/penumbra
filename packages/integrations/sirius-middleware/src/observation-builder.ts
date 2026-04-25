import type { T0EventInput } from '@penumbra/core';

export interface ChatMessage {
  role: string;
  content?: string | ChatMessageContentPart[];
}

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: unknown }
  | { type: string; [k: string]: unknown };

export interface ChatResponseLike {
  model?: string;
  provider?: string;
  choices?: unknown[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface BuildPromptInput {
  projectId: string;
  userId: string;
  machineId: string;
  requestId: string;
  model: string;
  messages: ChatMessage[];
  captureStartTs: number;
}

export interface BuildResponseInput extends BuildPromptInput {
  assistantText: string;
  response: ChatResponseLike;
  completionTs: number;
}

const ROUTE = '/v1/chat/completions';

export function buildPromptEvent(input: BuildPromptInput): T0EventInput {
  return {
    ts: new Date(input.captureStartTs).toISOString(),
    source: 'sirius-middleware',
    source_detail: ROUTE,
    project_id: input.projectId,
    user_id: input.userId,
    machine_id: input.machineId,
    session_id: input.requestId,
    event_type: 'agent-prompt',
    lane: 'unknown',
    provider: null,
    model: input.model,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: input.requestId,
    payload_json: { messages: input.messages },
    payload_summary: extractUserMessageText(input.messages),
  };
}

export function buildResponseEvent(input: BuildResponseInput): T0EventInput {
  const usage = input.response.usage ?? {};
  return {
    ts: new Date(input.completionTs).toISOString(),
    source: 'sirius-middleware',
    source_detail: ROUTE,
    project_id: input.projectId,
    user_id: input.userId,
    machine_id: input.machineId,
    session_id: input.requestId,
    event_type: 'agent-response',
    lane: 'unknown',
    provider: input.response.provider ?? null,
    model: input.response.model ?? input.model,
    tokens_in: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    tokens_out: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
    cost_usd: null,
    latency_ms: input.completionTs - input.captureStartTs,
    request_id: input.requestId,
    payload_json: {
      choices: input.response.choices ?? [],
      ...(input.response.usage ? { usage: input.response.usage } : {}),
    },
    payload_summary: input.assistantText,
  };
}

export function extractUserMessageText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const part of c) {
        if (part && typeof part === 'object') {
          if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
            parts.push((part as { text: string }).text);
          } else if (part.type === 'image_url') {
            parts.push('[image]');
          } else {
            parts.push('[binary]');
          }
        }
      }
      return parts.join(' ');
    }
    return '';
  }
  return '';
}
