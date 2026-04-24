import type { Clock } from '../utils/clock.js';
import type { Uuid } from '../utils/uuid.js';
import type { RegexRedactor } from '../redaction/regex.js';
import { stripPrivacyTags } from '../redaction/privacy-tags.js';
import { T0EventInputSchema, T0EventSchema, type T0Event, type T0EventInput } from '../schemas/event.js';

export interface NormalizeCtx {
  userId: string;
  machineId: string;
  now: Clock;
  uuid: Uuid;
  redactor: RegexRedactor;
}

export function normalize(input: T0EventInput, ctx: NormalizeCtx): T0Event {
  const validated = T0EventInputSchema.parse(input);
  const redactedPayload = ctx.redactor.redact(validated.payload_json) as Record<string, unknown>;
  const summary = validated.payload_summary === undefined || validated.payload_summary === null
    ? null
    : stripPrivacyTags(validated.payload_summary);

  const event: T0Event = {
    event_id: validated.event_id ?? ctx.uuid(),
    ts: validated.ts,
    ingest_ts: validated.ingest_ts ?? ctx.now().toISOString(),
    source: validated.source,
    source_detail: validated.source_detail ?? null,
    project_id: validated.project_id ?? null,
    user_id: ctx.userId,
    machine_id: ctx.machineId,
    session_id: validated.session_id ?? null,
    event_type: validated.event_type,
    lane: validated.lane,
    provider: validated.provider ?? null,
    model: validated.model ?? null,
    tokens_in: validated.tokens_in ?? null,
    tokens_out: validated.tokens_out ?? null,
    cost_usd: validated.cost_usd ?? null,
    latency_ms: validated.latency_ms ?? null,
    request_id: validated.request_id ?? null,
    payload_json: redactedPayload,
    payload_summary: summary,
  };
  return T0EventSchema.parse(event);
}
