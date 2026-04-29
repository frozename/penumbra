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

describe('codex.sse_event handler', () => {
  it('emits usage-update for completion events with provider=openai', () => {
    const records = [{
      timeUnixNano: '1777000000000000000',
      resourceAttrs: { 'service.name': 'codex-cli', 'service.version': 'v0.125.0' },
      scopeName: 'codex_otel',
      body: null,
      attrs: {
        'event.name': 'codex.sse_event',
        'event.kind': 'completion',
        'model': 'gpt-5.4',
        'conversation.id': 'conv-abc',
        'input_token_count': 1000,
        'output_token_count': 50,
        'cached_token_count': 200,
        'reasoning_token_count': 30,
        'tool_token_count': 0,
      },
    }];
    const events = normalizeOtlpLogsToUsageEvents(records);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event_type).toBe('usage-update');
    expect(ev.provider).toBe('openai');
    expect(ev.model).toBe('gpt-5.4');
    expect(ev.tokens_in).toBe(1000);
    expect(ev.tokens_out).toBe(50);
    expect(ev.session_id).toBe('conv-abc');
    expect(ev.payload_json.used).toBe(1050);
  });

  it('skips non-completion sse_event records (in-progress chunks)', () => {
    const records = [{
      timeUnixNano: '1', resourceAttrs: {}, scopeName: 'x', body: null,
      attrs: { 'event.name': 'codex.sse_event', 'event.kind': 'response_part' },
    }];
    expect(normalizeOtlpLogsToUsageEvents(records)).toHaveLength(0);
  });
});

describe('claude_code.api_request handler', () => {
  it('emits usage-update with cost_usd and cache tokens', () => {
    const records = [{
      timeUnixNano: '1777100000000000000',
      resourceAttrs: { 'service.name': 'claude-code', 'service.version': 'v2.1.123' },
      scopeName: 'com.anthropic.claude_code.events',
      body: null,
      attrs: {
        'event.name': 'claude_code.api_request',
        'model': 'claude-haiku-4-5',
        'input_tokens': 250,
        'output_tokens': 80,
        'cache_creation_tokens': 100,
        'cache_read_tokens': 5000,
        'cost_usd': 0.00123,
        'session.id': 'sess-xyz',
        'prompt.id': 'prompt-456',
      },
    }];
    const events = normalizeOtlpLogsToUsageEvents(records);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event_type).toBe('usage-update');
    expect(ev.provider).toBe('anthropic');
    expect(ev.model).toBe('claude-haiku-4-5');
    expect(ev.tokens_in).toBe(250);
    expect(ev.tokens_out).toBe(80);
    expect(ev.cost_usd).toBe(0.00123);
    expect(ev.session_id).toBe('sess-xyz');
    expect(ev.request_id).toBe('prompt-456');
    // cache fields preserved in payload for forensics
    expect(ev.payload_json['cache_creation_tokens']).toBe(100);
    expect(ev.payload_json['cache_read_tokens']).toBe(5000);
    // payload.used is the sum of input+output (cache fields are NOT counted toward used)
    expect(ev.payload_json.used).toBe(330);
  });

  it('skips claude_code log events that are not api_request (hooks, mcp, errors)', () => {
    const records = [
      { timeUnixNano: '1', resourceAttrs: {}, scopeName: 'x', body: null, attrs: { 'event.name': 'claude_code.hook_execution_start' } },
      { timeUnixNano: '2', resourceAttrs: {}, scopeName: 'x', body: null, attrs: { 'event.name': 'claude_code.mcp_server_connection' } },
    ];
    expect(normalizeOtlpLogsToUsageEvents(records)).toHaveLength(0);
  });
});
