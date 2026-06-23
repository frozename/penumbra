import type { T0EventInput } from "@penumbra/core";

export interface ChatMessage {
  role: string;
  content?: string | ChatMessageContentPart[];
}

export type ChatMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: unknown }
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

const ROUTE = "/v1/chat/completions";

function roundFiniteToken(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export function buildPromptEvent(input: BuildPromptInput): T0EventInput {
  return {
    ts: new Date(input.captureStartTs).toISOString(),
    source: "sirius-middleware",
    source_detail: ROUTE,
    project_id: input.projectId,
    user_id: input.userId,
    machine_id: input.machineId,
    session_id: input.requestId,
    event_type: "agent-prompt",
    lane: "unknown",
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
    source: "sirius-middleware",
    source_detail: ROUTE,
    project_id: input.projectId,
    user_id: input.userId,
    machine_id: input.machineId,
    session_id: input.requestId,
    event_type: "agent-response",
    lane: "unknown",
    provider: input.response.provider ?? null,
    model: input.model,
    tokens_in: roundFiniteToken(usage.prompt_tokens),
    tokens_out: roundFiniteToken(usage.completion_tokens),
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
    const message = messages[i];
    if (message === undefined) {
      continue;
    }
    if (message.role !== "user") {
      continue;
    }
    const summary = summarizeContent(message.content);
    if (summary !== null) {
      return summary;
    }
  }
  return "";
}

function summarizeContent(content: ChatMessage["content"]): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  return content.map(summarizeContentPart).join(" ");
}

function summarizeContentPart(part: ChatMessageContentPart): string {
  if (part.type === "text") {
    return typeof part.text === "string" ? part.text : "[binary]";
  }
  return part.type === "image_url" ? "[image]" : "[binary]";
}
