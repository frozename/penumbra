import type { ParsedLogRecord } from './types.js';
import type { T0EventInput } from '../schemas/event.js';

// Attribute keys that carry user-content or user-identifiers and must NOT be
// persisted in payload_json. Checked against the un-prefixed key, so it covers
// both log-record attrs and resource attrs (which get a "resource." prefix
// when written to payload_json — but that prefix is added AFTER this filter).
//
// gen_ai.* — prompt content and system instructions (Phase 3c)
// user.email / user.id / user.account_id / user.account_uuid — claude-code
//   resource attrs (Phase 3d). Local-only DB mitigates today, but redacting
//   here keeps the cost-ledger free of personal identifiers in case the DB is
//   ever exported.
const PII_KEYS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'user.email',
  'user.id',
  'user.account_id',
  'user.account_uuid',
]);

const PROVIDER_MAP: Record<string, string> = {
  'gcp.vertex_ai': 'google',
  'gcp.gemini_api': 'google',
};

// Service-name -> provider fallback (used when gen_ai.provider.name attribute is absent).
const SERVICE_TO_PROVIDER: Record<string, string> = {
  'codex-cli': 'openai',
  'claude-code': 'anthropic',
  'gemini-cli': 'google',
};

export function mapProvider(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return PROVIDER_MAP[raw] ?? raw;
}

function nanoToIso(nanoStr: string | null): string {
  if (!nanoStr) return new Date().toISOString();
  const ns = BigInt(nanoStr);
  const ms = Number(ns / 1_000_000n);
  return new Date(ms).toISOString();
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function redact(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_KEYS.has(k)) continue;
    out[prefix + k] = v;
  }
  return out;
}

export type LogHandler = (rec: ParsedLogRecord) => T0EventInput | null;

export const LOG_HANDLERS: Record<string, LogHandler> = {
  'gen_ai.client.inference.operation.details': handleGenAiInferenceLog,
  'codex.sse_event': handleCodexSseEvent,
  'claude_code.api_request': handleClaudeCodeApiRequest,
};

function providerFromRecord(rec: ParsedLogRecord): string | null {
  const fromAttr = mapProvider(asString(rec.attrs['gen_ai.provider.name']));
  if (fromAttr) return fromAttr;
  const svc = asString(rec.resourceAttrs['service.name']);
  if (svc && SERVICE_TO_PROVIDER[svc]) return SERVICE_TO_PROVIDER[svc]!;
  return null;
}

function handleGenAiInferenceLog(rec: ParsedLogRecord): T0EventInput | null {
  const provider = providerFromRecord(rec);
  const model = asString(rec.attrs['gen_ai.request.model']) ?? asString(rec.attrs['gen_ai.response.model']);
  const tokensIn = asNumber(rec.attrs['gen_ai.usage.input_tokens']);
  const tokensOut = asNumber(rec.attrs['gen_ai.usage.output_tokens']);
  const requestId = asString(rec.attrs['gen_ai.response.id']);
  const sessionId = asString(rec.attrs['session.id']) ?? asString(rec.resourceAttrs['session.id']);
  const ts = nanoToIso(rec.timeUnixNano);

  const usedTotal = (tokensIn ?? 0) + (tokensOut ?? 0);
  const payload: Record<string, unknown> = {
    ...redact(rec.attrs),
    ...redact(rec.resourceAttrs, 'resource.'),
    used: usedTotal,
  };

  return {
    ts,
    source: 'agentchat',
    source_detail: 'otlp',
    user_id: 'unknown',
    machine_id: 'unknown',
    session_id: sessionId,
    event_type: 'usage-update',
    lane: 'cloud',
    provider,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: null,
    latency_ms: null,
    request_id: requestId,
    payload_json: payload,
  };
}

function handleCodexSseEvent(rec: ParsedLogRecord): T0EventInput | null {
  // codex-cli (PR #2103) emits 'response.completed' on the final SSE event with
  // token counts. Other kinds (e.g. response_part chunks) carry no usage data.
  if (asString(rec.attrs['event.kind']) !== 'response.completed') return null;
  const provider = providerFromRecord(rec) ?? 'openai';
  const model = asString(rec.attrs['model']);
  const tokensIn = asNumber(rec.attrs['input_token_count']);
  const tokensOut = asNumber(rec.attrs['output_token_count']);
  const sessionId = asString(rec.attrs['conversation.id']);
  const ts = nanoToIso(rec.timeUnixNano);

  const usedTotal = (tokensIn ?? 0) + (tokensOut ?? 0);
  const payload: Record<string, unknown> = {
    ...redact(rec.attrs),
    ...redact(rec.resourceAttrs, 'resource.'),
    used: usedTotal,
  };

  return {
    ts,
    source: 'agentchat',
    source_detail: 'otlp',
    user_id: 'unknown',
    machine_id: 'unknown',
    session_id: sessionId,
    event_type: 'usage-update',
    lane: 'cloud',
    provider,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payload,
  };
}

function handleClaudeCodeApiRequest(rec: ParsedLogRecord): T0EventInput | null {
  const provider = providerFromRecord(rec) ?? 'anthropic';
  const model = asString(rec.attrs['model']);
  const tokensIn = asNumber(rec.attrs['input_tokens']);
  const tokensOut = asNumber(rec.attrs['output_tokens']);
  const costUsd = asNumber(rec.attrs['cost_usd']);
  const sessionId = asString(rec.attrs['session.id']) ?? asString(rec.resourceAttrs['session.id']);
  const requestId = asString(rec.attrs['prompt.id']);
  const ts = nanoToIso(rec.timeUnixNano);
  const usedTotal = (tokensIn ?? 0) + (tokensOut ?? 0);
  const payload: Record<string, unknown> = {
    ...redact(rec.attrs),
    ...redact(rec.resourceAttrs, 'resource.'),
    used: usedTotal,
  };
  return {
    ts,
    source: 'agentchat',
    source_detail: 'otlp',
    user_id: 'unknown',
    machine_id: 'unknown',
    session_id: sessionId,
    event_type: 'usage-update',
    lane: 'cloud',
    provider,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    latency_ms: null,
    request_id: requestId,
    payload_json: payload,
  };
}

export function normalizeOtlpLogsToUsageEvents(records: ParsedLogRecord[]): T0EventInput[] {
  const out: T0EventInput[] = [];
  for (const rec of records) {
    const eventName = asString(rec.attrs['event.name']);
    const bodyName = asString(rec.body);
    const handler = (eventName && LOG_HANDLERS[eventName]) || (bodyName && LOG_HANDLERS[bodyName]);
    if (!handler) continue;
    const ev = handler(rec);
    if (ev) out.push(ev);
  }
  return out;
}
