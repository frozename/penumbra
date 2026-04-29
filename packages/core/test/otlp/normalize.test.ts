import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOtlpLogs } from '../../src/otlp/parse.js';
import { normalizeOtlpLogsToUsageEvents, mapProvider } from '../../src/otlp/normalize.js';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures');

describe('mapProvider', () => {
  it('maps gcp.vertex_ai to google', () => {
    expect(mapProvider('gcp.vertex_ai')).toBe('google');
  });
  it('passes through known canonical names', () => {
    expect(mapProvider('anthropic')).toBe('anthropic');
    expect(mapProvider('openai')).toBe('openai');
  });
  it('passes through unknown values unchanged', () => {
    expect(mapProvider('something.else')).toBe('something.else');
  });
});

describe('normalizeOtlpLogsToUsageEvents', () => {
  it('emits one usage-update T0EventInput per inference.operation.details record from gemini fixture', () => {
    const raw = readFileSync(join(FIXTURE_DIR, 'gemini-logs.json'), 'utf8');
    const records = parseOtlpLogs(JSON.parse(raw));
    const events = normalizeOtlpLogsToUsageEvents(records);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => typeof e.tokens_in === 'number' && (e.tokens_in ?? 0) > 0)!;
    expect(ev).toBeDefined();
    expect(ev.event_type).toBe('usage-update');
    expect(ev.provider).toBe('google');
    expect(ev.model).toBe('gemini-3-flash-preview');
    expect(ev.tokens_in).toBeGreaterThan(0);
    expect(ev.source).toBe('agentchat');
    expect(ev.source_detail).toBe('otlp');
    expect(ev.lane).toBe('cloud');
    expect(ev.request_id).toBeDefined();
    expect(typeof ev.request_id).toBe('string');
  });

  it('strips PII keys from payload_json', () => {
    const raw = readFileSync(join(FIXTURE_DIR, 'gemini-logs.json'), 'utf8');
    const records = parseOtlpLogs(JSON.parse(raw));
    const events = normalizeOtlpLogsToUsageEvents(records);
    for (const ev of events) {
      expect(ev.payload_json['gen_ai.input.messages']).toBeUndefined();
      expect(ev.payload_json['gen_ai.output.messages']).toBeUndefined();
      expect(ev.payload_json['gen_ai.system_instructions']).toBeUndefined();
    }
  });

  it('preserves non-PII attrs in payload_json', () => {
    const raw = readFileSync(join(FIXTURE_DIR, 'gemini-logs.json'), 'utf8');
    const records = parseOtlpLogs(JSON.parse(raw));
    const events = normalizeOtlpLogsToUsageEvents(records);
    const ev = events.find((e) => typeof e.tokens_in === 'number' && (e.tokens_in ?? 0) > 0)!;
    expect(ev.payload_json['gen_ai.response.finish_reasons']).toBeDefined();
    expect(ev.payload_json['gen_ai.request.temperature']).toBeDefined();
  });

  it('sets payload_json.used so cost.ts SQL aggregation finds it', () => {
    const raw = readFileSync(join(FIXTURE_DIR, 'gemini-logs.json'), 'utf8');
    const records = parseOtlpLogs(JSON.parse(raw));
    const events = normalizeOtlpLogsToUsageEvents(records);
    const ev = events.find((e) => typeof e.tokens_in === 'number' && (e.tokens_in ?? 0) > 0)!;
    expect(ev.payload_json.used).toBe((ev.tokens_in ?? 0) + (ev.tokens_out ?? 0));
    expect(ev.payload_json.used).toBeGreaterThan(0);
  });

  it('skips records that are not gen_ai.client.inference.operation.details', () => {
    const records = [
      { timeUnixNano: '1', resourceAttrs: {}, scopeName: 'x', body: null, attrs: { 'event.name': 'gen_ai.client.inference.operation.details', 'gen_ai.request.model': 'm', 'gen_ai.provider.name': 'openai', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 1 } },
      { timeUnixNano: '2', resourceAttrs: {}, scopeName: 'x', body: 'hello', attrs: { 'event.name': 'something_else' } },
    ];
    const events = normalizeOtlpLogsToUsageEvents(records);
    expect(events).toHaveLength(1);
  });

  it('returns [] when no records have inference event.name', () => {
    expect(normalizeOtlpLogsToUsageEvents([])).toEqual([]);
  });
});
