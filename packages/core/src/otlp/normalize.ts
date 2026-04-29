import type { ParsedLogRecord } from './types.js';
import type { T0EventInput } from '../schemas/event.js';

const PII_KEYS = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
]);

const PROVIDER_MAP: Record<string, string> = {
  'gcp.vertex_ai': 'google',
  'gcp.gemini_api': 'google',
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
};

function handleGenAiInferenceLog(rec: ParsedLogRecord): T0EventInput | null {
  const provider = mapProvider(asString(rec.attrs['gen_ai.provider.name']));
  const model = asString(rec.attrs['gen_ai.request.model']) ?? asString(rec.attrs['gen_ai.response.model']);
  const tokensIn = asNumber(rec.attrs['gen_ai.usage.input_tokens']);
  const tokensOut = asNumber(rec.attrs['gen_ai.usage.output_tokens']);
  const requestId = asString(rec.attrs['gen_ai.response.id']);
  const sessionId = asString(rec.attrs['session.id']) ?? asString(rec.resourceAttrs['session.id']);
  const ts = nanoToIso(rec.timeUnixNano);

  const payload: Record<string, unknown> = {
    ...redact(rec.attrs),
    ...redact(rec.resourceAttrs, 'resource.'),
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

export function normalizeOtlpLogsToUsageEvents(records: ParsedLogRecord[]): T0EventInput[] {
  const out: T0EventInput[] = [];
  for (const rec of records) {
    const eventName = asString(rec.attrs['event.name']);
    if (!eventName) continue;
    const handler = LOG_HANDLERS[eventName];
    if (!handler) continue;
    const ev = handler(rec);
    if (ev) out.push(ev);
  }
  return out;
}
