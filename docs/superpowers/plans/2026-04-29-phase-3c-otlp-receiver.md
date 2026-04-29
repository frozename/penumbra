# Phase 3c — OTLP Receiver (Path B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the penumbra daemon a local OpenTelemetry collector for the CLI fleet so any tool that exports GenAI-conventions OTel (gemini-cli today; claude-code/codex/opencode likely soon) feeds the cost ledger via one ingest path instead of per-tool readers.

**Architecture:** Three new HTTP routes on the daemon (`POST /v1/metrics`, `POST /v1/logs`, `POST /v1/traces`) accept OTLP/JSON envelopes. A pure parser walks the JSON envelope; a normalizer maps `gen_ai.client.inference.operation.details` log records (tokens + model + request id) to `usage-update` T0 events, stripping PII (messages, system instructions) before persistence. Metrics and traces are accepted-and-discarded (200 OK) for now — they're noisy duplicates of the log signal, but accepting them keeps gemini-cli's exporter happy. A `penumbra hooks install --gemini-otel` subcommand writes the daemon's port into `~/.gemini/settings.json`. Auth: localhost-only — daemon already binds to 127.0.0.1, so OTLP routes bypass bearer auth and rely on loopback isolation. Per-model quota visibility is added by extending `ProviderQuota{Config}` with an optional `model` field and aggregating `recentCost`/`quotaStatus` by `(provider, model)`. A capacity-error tracker pattern-matches `RetryableQuotaError: No capacity` from cli-spawn stderr and emits a new `provider-capacity-error` event surfaced as `recent_capacity_flaps`.

**Tech Stack:** Bun.serve, TypeScript, zod, sqlite3 (bun:sqlite), OTLP/JSON over HTTP (no protobuf dep — gemini-cli emits JSON when `OTLP_PROTOCOL=http`), GenAI semantic conventions (`gen_ai.*` attributes).

**Probe captures preserved at:** `/tmp/otlp-probe/00{03..12}-v1_*.body.{bin,json}` and `.meta.json`. Use these as test fixtures.

---

## Multi-tool OTel landscape (2026-04-29)

The "build once" thesis is validated by 3 of 4 major coding CLIs:

| Tool | Status | Event/attribute scheme | Default OTLP protocol | Config surface |
|---|---|---|---|---|
| **gemini-cli** | shipped | GenAI conventions: `gen_ai.client.inference.operation.details` log + `gen_ai.client.token.usage` metric | HTTP/JSON when `OTLP_PROTOCOL=http`; gRPC default | `~/.gemini/settings.json` `telemetry` block, or `GEMINI_TELEMETRY_*` env vars |
| **claude-code / Agent SDK** | shipped | `claude_code.*` spans + standard `OTEL_*` config | HTTP/protobuf | `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_EXPORTER_OTLP_*` env vars |
| **codex** | merged ([PR 2103](https://github.com/openai/codex/pull/2103)) | `codex.sse_event` log records with `input_token_count`/`output_token_count` (completion only) | HTTP/protobuf (`protocol = "binary"`) | `[otel]` block in `~/.codex/config.toml`; `exporter = "otlp-http"` |
| **opencode** | requested ([#12142](https://github.com/anomalyco/opencode/issues/12142)) | TBD | TBD | TBD |

**Implications for this phase:**
1. Phase 3c ships gemini-cli ingest only (HTTP/JSON; codex's protobuf default and claude-code's `claude_code.*` event names are deferred to Phase 3d).
2. Normalizer must be a **dispatch registry keyed on `event.name`** so adding codex/claude-code is a one-file change in 3d.
3. Protobuf support is a Phase 3d task (we'll need it for codex and claude-code; gemini-cli works fine without it).
4. Hooks command surface should be extensible: today `--gemini-otel`; tomorrow `--codex-otel`, `--claude-otel`.

---

## Probe-Validated Decisions (locked, do not relitigate)

1. **JSON, not protobuf.** Setting `GEMINI_TELEMETRY_OTLP_PROTOCOL=http` makes gemini-cli emit `application/json` bodies. No protobuf decoder dependency.
2. **Logs path is the canonical usage signal.** The log record `gen_ai.client.inference.operation.details` carries `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.id`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name`, `gen_ai.response.finish_reasons` — everything we need per call. The metrics histogram (`gen_ai.client.token.usage`) duplicates this aggregated form and is harder to dedup; **drop it** for now.
3. **PII redaction is mandatory.** The same log record carries `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`. These MUST be stripped before persisting to `payload_json`.
4. **Provider mapping table:** `gcp.vertex_ai` → `google`, `anthropic` → `anthropic`, `openai` → `openai`. Unknown values pass through as-is.
5. **Auth: localhost-only, no bearer.** Daemon already binds to 127.0.0.1 (per memory `9051`). OTLP routes are mounted before the bearer auth gate, like `/health`.
6. **Same port as daemon.** OTLP server reuses the daemon's `Bun.serve` instance on its dynamic port. `penumbra hooks install --gemini-otel` reads the port from `/tmp/penumbra-live/port` and writes it into `~/.gemini/settings.json`. Operator reruns hooks install after daemon restart if port changes — same UX pattern as Phase 3b's claude statusline.
7. **Traces endpoint is no-op 200.** Gemini-cli also POSTs to `/v1/traces`. Accept and discard so the exporter doesn't backpressure-error.

---

## File Structure

**Created:**
- `packages/core/src/otlp/parse.ts` — pure parser: OTLP/JSON envelope → typed structures (resource attrs, scope, log records, metric data points)
- `packages/core/src/otlp/normalize.ts` — pure: `gen_ai.client.inference.operation.details` log records → `T0EventInput[]` for `usage-update`; PII redaction
- `packages/core/src/otlp/types.ts` — shared TypeScript types for parsed OTLP shapes
- `packages/core/test/otlp/parse.test.ts`
- `packages/core/test/otlp/normalize.test.ts`
- `packages/core/test/otlp/fixtures/gemini-logs.json` (copy of probe capture)
- `packages/core/test/otlp/fixtures/gemini-metrics.json` (copy of probe capture)
- `packages/daemon/src/routes/otlp.ts` — POST /v1/metrics, /v1/logs, /v1/traces handlers
- `packages/daemon/test/routes/otlp.test.ts`

**Modified:**
- `packages/core/src/schemas/event.ts` — add `'provider-capacity-error'` to `EventTypeSchema`
- `packages/core/src/index.ts` — export OTLP parse + normalize
- `packages/core/src/readers/cost.ts` — add `by_provider_model` aggregation alongside `by_provider`
- `packages/core/src/readers/cost-quota.ts` — extend `ProviderQuota` with optional `model`; aggregate by `(provider, model)`
- `packages/agentchat/src/config/types.ts` — extend `ProviderQuotaConfigSchema` with `model?: string` and `quota_tokens_per_5h?: number`
- `packages/daemon/src/agentchat-config.ts` — pass `model` through `loadProviderQuotas`
- `packages/daemon/src/serve.ts` — register OTLP routes BEFORE bearer auth gate
- `packages/agentchat/src/adapters/cli-spawn.ts` — pattern-match stderr for capacity errors, emit `provider-capacity-error` event
- `packages/cli/src/commands/hooks.ts` — add `runHooksInstallGeminiOtel`, `runHooksUninstallGeminiOtel`
- `packages/cli/bin/penumbra.ts` — wire `--gemini-otel` subcommand

**Operator-side (manual, T9):**
- `~/.config/agentchat/agentchat.yaml` — add per-model entries for google
- `~/.gemini/settings.json` — written by `penumbra hooks install --gemini-otel`

---

## Task Routing (informational; for the orchestrator)

| Task | Suggested agent | Why |
|---|---|---|
| T1 schema enum | `codex-mini` | Surgical mechanical edit, mirrors Phase 3b T1 |
| T2 parser | `oc-deepseek-v4-pro` or `gemini` | Substantive; large fixture-driven tests |
| T3 normalizer | `oc-mimo-v2.5-pro` | Substantive impl, PII redaction logic, multiple tests |
| T4 routes | `oc-mimo-v2.5-pro` | Mirrors T7 route pattern from Phase 3b |
| T5 quota schema | `codex-mini` | Mechanical schema extension |
| T6 quota aggregation | `oc-mimo-v2.5-pro` | Substantive SQL change |
| T7 capacity tracker | `codex-mini` | Small, surgical, regex + emit |
| T8 hooks install | `oc-mimo-v2.5-pro` | Mirrors T18 hooks install pattern |
| T9 live verification | maestro hand-edit | Operator-side dispatch + check |

Two-round cap. Maestro hand-edits round-3+. Don't tell agents to restart the worker.

---

# Tasks

## Task 1: Add `provider-capacity-error` event type to EventTypeSchema

**Files:**
- Modify: `packages/core/src/schemas/event.ts:6-13`
- Test: `packages/core/test/schemas/event.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/schemas/event.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { EventTypeSchema } from '../../src/schemas/event.js';

describe('EventTypeSchema', () => {
  it('accepts provider-capacity-error', () => {
    expect(() => EventTypeSchema.parse('provider-capacity-error')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/schemas/event.test.ts -t "provider-capacity-error"`
Expected: FAIL with "Invalid enum value. Expected 'agent-prompt' | ... | 'terminal.killed', received 'provider-capacity-error'"

- [ ] **Step 3: Add the enum literal**

In `packages/core/src/schemas/event.ts`, change:

```typescript
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'usage-update', 'rate-limit-snapshot',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

to:

```typescript
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'usage-update', 'rate-limit-snapshot', 'provider-capacity-error',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/schemas/event.test.ts`
Expected: PASS, plus all other event schema tests still PASS.

- [ ] **Step 5: Run package typecheck**

Run: `bun run --filter @penumbra/core typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event.test.ts
git commit -m "feat(core): add provider-capacity-error event type"
```

- [ ] **Step 7: Restart daemon (schema enum change)**

Per memory `feedback_daemon_restart_on_schema_change.md` — daemon caches zod enums at boot.

```bash
kill $(cat /tmp/penumbra-live/pid) 2>/dev/null
sleep 1
bun packages/cli/bin/penumbra.ts start &
sleep 2
curl -s http://localhost:$(cat /tmp/penumbra-live/port)/health
```

Expected: `{"status":"ok"...}` from the new daemon.

---

## Task 2: OTLP/JSON envelope parser

**Files:**
- Create: `packages/core/src/otlp/types.ts`
- Create: `packages/core/src/otlp/parse.ts`
- Create: `packages/core/test/otlp/parse.test.ts`
- **Pre-staged (no copy needed):** `packages/core/test/otlp/fixtures/gemini-logs.json` and `packages/core/test/otlp/fixtures/gemini-metrics.json` — already in the repo, redacted from the probe captures (user.email, host.name, session.id, installation.id replaced with placeholders; `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` replaced with `<redacted>`; non-inference log records dropped to keep the fixture small and PII-free).

- [ ] **Step 1: Verify fixtures are present and PII-free**

```bash
ls packages/core/test/otlp/fixtures/
grep -c "alexandre\|MacBook\|acordeiro\|/Users/" packages/core/test/otlp/fixtures/*.json
```

Expected: `gemini-logs.json` (~13KB) and `gemini-metrics.json` (~67KB) present; PII grep returns `0:` for both files.

- [ ] **Step 2: Define types**

Create `packages/core/src/otlp/types.ts`:

```typescript
export type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: number | string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAttrValue[] } }
  | Record<string, never>; // empty {} when value is unset

export interface OtlpAttribute {
  key: string;
  value: OtlpAttrValue;
}

export interface OtlpResource {
  attributes: OtlpAttribute[];
  droppedAttributesCount?: number;
}

export interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  body?: { stringValue?: string };
  attributes: OtlpAttribute[];
  droppedAttributesCount?: number;
}

export interface OtlpScopeLogs {
  scope: { name?: string; version?: string };
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: OtlpResource;
  scopeLogs: OtlpScopeLogs[];
}

export interface OtlpLogsEnvelope {
  resourceLogs: OtlpResourceLogs[];
}

export interface ParsedLogRecord {
  timeUnixNano: string | null;
  resourceAttrs: Record<string, unknown>;
  scopeName: string | null;
  body: string | null;
  attrs: Record<string, unknown>;
}

export function attrToValue(v: OtlpAttrValue): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return v.arrayValue.values.map(attrToValue);
  return null;
}

export function attrsToObject(attrs: OtlpAttribute[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs) out[a.key] = attrToValue(a.value);
  return out;
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/core/test/otlp/parse.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOtlpLogs } from '../../src/otlp/parse.js';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures');

describe('parseOtlpLogs', () => {
  it('extracts log records from a gemini-cli OTLP/JSON logs envelope', () => {
    const raw = readFileSync(join(FIXTURE_DIR, 'gemini-logs.json'), 'utf8');
    const records = parseOtlpLogs(JSON.parse(raw));
    expect(records.length).toBeGreaterThan(0);
    const inference = records.find((r) => r.attrs['event.name'] === 'gen_ai.client.inference.operation.details');
    expect(inference).toBeDefined();
    expect(inference!.attrs['gen_ai.request.model']).toBe('gemini-3-flash-preview');
    expect(inference!.attrs['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
    expect(inference!.attrs['gen_ai.usage.output_tokens']).toBeGreaterThanOrEqual(0);
    expect(inference!.resourceAttrs['service.name']).toBe('gemini-cli');
  });

  it('returns [] for an envelope with no resourceLogs', () => {
    expect(parseOtlpLogs({})).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: [] })).toEqual([]);
  });

  it('handles empty value objects (e.g. unset gen_ai.request.seed)', () => {
    const env = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'x' } }] },
        scopeLogs: [{
          scope: { name: 'x' },
          logRecords: [{ attributes: [{ key: 'k', value: {} }] }],
        }],
      }],
    };
    const records = parseOtlpLogs(env);
    expect(records[0]!.attrs['k']).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/core/test/otlp/parse.test.ts`
Expected: FAIL with "Cannot find module '../../src/otlp/parse.js'".

- [ ] **Step 5: Implement the parser**

Create `packages/core/src/otlp/parse.ts`:

```typescript
import type { OtlpLogsEnvelope, ParsedLogRecord, OtlpResourceLogs } from './types.js';
import { attrsToObject } from './types.js';

export function parseOtlpLogs(envelope: unknown): ParsedLogRecord[] {
  const env = envelope as Partial<OtlpLogsEnvelope> | null | undefined;
  if (!env || !Array.isArray(env.resourceLogs)) return [];
  const out: ParsedLogRecord[] = [];
  for (const rl of env.resourceLogs as OtlpResourceLogs[]) {
    const resourceAttrs = attrsToObject(rl.resource?.attributes ?? []);
    for (const sl of rl.scopeLogs ?? []) {
      const scopeName = sl.scope?.name ?? null;
      for (const lr of sl.logRecords ?? []) {
        out.push({
          timeUnixNano: lr.timeUnixNano ?? null,
          resourceAttrs,
          scopeName,
          body: lr.body?.stringValue ?? null,
          attrs: attrsToObject(lr.attributes ?? []),
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/core/test/otlp/parse.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter @penumbra/core typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/otlp/ packages/core/test/otlp/
git commit -m "feat(core): OTLP/JSON logs envelope parser"
```

---

## Task 3: OTel → T0Event normalizer (with PII redaction)

**Files:**
- Create: `packages/core/src/otlp/normalize.ts`
- Create: `packages/core/test/otlp/normalize.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/otlp/normalize.test.ts`:

```typescript
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
    const ev = events[0]!;
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
    const ev = events[0]!;
    expect(ev.payload_json['gen_ai.response.finish_reasons']).toBeDefined();
    expect(ev.payload_json['gen_ai.request.temperature']).toBeDefined();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/otlp/normalize.test.ts`
Expected: FAIL with "Cannot find module '../../src/otlp/normalize.js'".

- [ ] **Step 3: Implement the normalizer (registry-based dispatch)**

Create `packages/core/src/otlp/normalize.ts`:

```typescript
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

/**
 * Per-event-name handler. Returns a usage T0EventInput, or null if the record
 * isn't a usage-bearing event for this handler.
 */
export type LogHandler = (rec: ParsedLogRecord) => T0EventInput | null;

/**
 * Registry keyed on the log record's `event.name` attribute. Add a new tool by
 * registering its handler here. Today: gemini-cli (GenAI conventions).
 * Phase 3d adds: codex (`codex.sse_event`), claude-code (`claude_code.api_request`).
 */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/otlp/normalize.test.ts`
Expected: PASS — 7 tests across both `describe` blocks.

- [ ] **Step 5: Export from core/index.ts**

In `packages/core/src/index.ts`, add:

```typescript
export { parseOtlpLogs } from './otlp/parse.js';
export { normalizeOtlpLogsToUsageEvents, mapProvider } from './otlp/normalize.js';
export type { ParsedLogRecord } from './otlp/types.js';
```

- [ ] **Step 6: Typecheck**

Run: `bun run --filter @penumbra/core typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/otlp/normalize.ts packages/core/test/otlp/normalize.test.ts packages/core/src/index.ts
git commit -m "feat(core): OTLP→T0 normalizer with PII redaction"
```

---

## Task 4: Daemon OTLP routes (`/v1/metrics`, `/v1/logs`, `/v1/traces`)

**Files:**
- Create: `packages/daemon/src/routes/otlp.ts`
- Create: `packages/daemon/test/routes/otlp.test.ts`
- Modify: `packages/daemon/src/serve.ts:1-79` (imports + route registration)

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/otlp.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from '../../src/routes/otlp.js';
import { buildTestServices } from '@penumbra/core';

const FIXTURE_PATH = join(import.meta.dir, '..', '..', '..', 'core', 'test', 'otlp', 'fixtures', 'gemini-logs.json');

describe('otlpLogsRoute', () => {
  it('parses, normalizes, and ingests usage-update events from a gemini envelope', async () => {
    const services = buildTestServices();
    const body = readFileSync(FIXTURE_PATH, 'utf8');
    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(200);
    const rows = services.db.prepare(`SELECT provider, model, event_type FROM t0_events WHERE event_type='usage-update'`).all() as Array<{ provider: string; model: string; event_type: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.provider).toBe('google');
    expect(rows[0]!.model).toBe('gemini-3-flash-preview');
  });

  it('returns 400 on non-JSON content-type', async () => {
    const services = buildTestServices();
    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: 'binarygunk',
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(415);
  });

  it('returns 400 on malformed JSON', async () => {
    const services = buildTestServices();
    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(400);
  });
});

describe('otlpMetricsRoute', () => {
  it('returns 200 and discards (no rows ingested)', async () => {
    const services = buildTestServices();
    const req = new Request('http://localhost/v1/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceMetrics":[]}',
    });
    const res = await otlpMetricsRoute(req, services);
    expect(res.status).toBe(200);
    const n = services.db.prepare(`SELECT COUNT(*) AS n FROM t0_events`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('otlpTracesRoute', () => {
  it('returns 200 and discards', async () => {
    const services = buildTestServices();
    const req = new Request('http://localhost/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceSpans":[]}',
    });
    const res = await otlpTracesRoute(req, services);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/routes/otlp.test.ts`
Expected: FAIL with "Cannot find module '../../src/routes/otlp.js'".

- [ ] **Step 3: Implement the routes**

Create `packages/daemon/src/routes/otlp.ts`:

```typescript
import type { Services } from '@penumbra/core';
import { parseOtlpLogs, normalizeOtlpLogsToUsageEvents, writeT0Event } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isJson(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.includes('application/json');
}

export async function otlpLogsRoute(req: Request, services: Services): Promise<Response> {
  if (!isJson(req)) return json({ error: { code: 'unsupported_media_type', message: 'OTLP/HTTP route requires application/json (set OTLP_PROTOCOL=http on exporter)' } }, 415);
  let envelope: unknown;
  try { envelope = await req.json(); }
  catch (e) { return json({ error: { code: 'invalid_json', message: (e as Error).message } }, 400); }

  const records = parseOtlpLogs(envelope);
  const events = normalizeOtlpLogsToUsageEvents(records);
  for (const ev of events) {
    writeT0Event(services.db, ev, services.clock);
  }
  return json({ accepted: events.length });
}

export async function otlpMetricsRoute(req: Request, _services: Services): Promise<Response> {
  if (!isJson(req)) return json({ error: { code: 'unsupported_media_type' } }, 415);
  // Accept-and-discard: gemini-cli double-reports tokens via metrics+logs.
  // We use the logs path as canonical (Task 3) to avoid double-counting.
  try { await req.text(); } catch { /* ignore */ }
  return json({ accepted: 0 });
}

export async function otlpTracesRoute(req: Request, _services: Services): Promise<Response> {
  if (!isJson(req)) return json({ error: { code: 'unsupported_media_type' } }, 415);
  try { await req.text(); } catch { /* ignore */ }
  return json({ accepted: 0 });
}
```

Note: `writeT0Event` is the existing T0 writer. Verify it's exported from `@penumbra/core`. If exported under a different name (e.g., `writeT0`), align this code with the actual export.

- [ ] **Step 4: Verify writeT0Event export**

Run: `grep -n "export.*writeT0\|export.*ingestT0\|export.*ingest" packages/core/src/index.ts | head -5`
Expected: confirms which symbol writes T0 events. Adjust the import in `routes/otlp.ts` if needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/daemon/test/routes/otlp.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Register routes in serve.ts (BEFORE auth gate)**

In `packages/daemon/src/serve.ts`, modify the imports block (line 6 area) to add:

```typescript
import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from './routes/otlp.js';
```

In the fetch handler, add the three OTLP routes BEFORE the `const denied = auth(req);` line so they bypass bearer auth (daemon already binds to 127.0.0.1, so loopback isolation is sufficient):

```typescript
    if (url.pathname === '/health') return healthRoute();
    // OTLP routes: localhost-only via daemon's 127.0.0.1 bind, no bearer.
    if (req.method === 'POST' && url.pathname === '/v1/logs') return otlpLogsRoute(req, opts.services);
    if (req.method === 'POST' && url.pathname === '/v1/metrics') return otlpMetricsRoute(req, opts.services);
    if (req.method === 'POST' && url.pathname === '/v1/traces') return otlpTracesRoute(req, opts.services);
    const denied = auth(req);
    if (denied) return denied;
```

- [ ] **Step 7: Run full daemon tests**

Run: `bun test packages/daemon`
Expected: PASS, no regressions.

- [ ] **Step 8: Typecheck**

Run: `bun run --filter @penumbra/daemon typecheck`
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src/routes/otlp.ts packages/daemon/src/serve.ts packages/daemon/test/routes/otlp.test.ts
git commit -m "feat(daemon): OTLP/JSON routes for /v1/logs|metrics|traces"
```

---

## Task 5: Per-model `ProviderQuotaConfig` schema

**Files:**
- Modify: `packages/agentchat/src/config/types.ts:43-48`
- Modify: `packages/daemon/src/agentchat-config.ts:25-32`
- Modify: `packages/core/src/readers/cost-quota.ts:4-8`
- Test: `packages/agentchat/test/config/load.test.ts` (or create if absent)

- [ ] **Step 1: Write the failing test**

Add to `packages/agentchat/test/config/load.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';

describe('ProviderQuotaConfig per-model', () => {
  it('loads a model-scoped quota entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'penumbra-cfg-'));
    const yamlPath = join(dir, 'agentchat.yaml');
    writeFileSync(yamlPath, [
      'agents:',
      '  - name: x',
      '    adapter: cli-spawn',
      'providers:',
      '  - name: google',
      '    model: gemini-3.1-pro-preview',
      '    quota_tokens_per_5h: 1000000',
      '    quota_tokens_per_24h: 4000000',
    ].join('\n'));
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({
      name: 'google',
      model: 'gemini-3.1-pro-preview',
      quota_tokens_per_5h: 1_000_000,
      quota_tokens_per_24h: 4_000_000,
    });
  });

  it('still accepts provider-level (no-model) entries for backwards compatibility', () => {
    const dir = mkdtempSync(join(tmpdir(), 'penumbra-cfg-'));
    const yamlPath = join(dir, 'agentchat.yaml');
    writeFileSync(yamlPath, [
      'agents:',
      '  - name: x',
      '    adapter: cli-spawn',
      'providers:',
      '  - name: anthropic',
      '    quota_usd_per_24h: 200',
    ].join('\n'));
    const cfg = loadConfig(yamlPath);
    expect(cfg.providers[0]!.model).toBeUndefined();
    expect(cfg.providers[0]!.quota_usd_per_24h).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agentchat/test/config/load.test.ts -t "per-model"`
Expected: FAIL — extra fields rejected by zod, or `model` not present in inferred type.

- [ ] **Step 3: Extend the zod schema**

In `packages/agentchat/src/config/types.ts`, change:

```typescript
export const ProviderQuotaConfigSchema = z.object({
  name: z.string().min(1),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
});
```

to:

```typescript
export const ProviderQuotaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
  quota_tokens_per_5h: z.number().int().positive().optional(),
});
```

- [ ] **Step 4: Extend the ProviderQuota interface in core**

In `packages/core/src/readers/cost-quota.ts:4-8`, change:

```typescript
export interface ProviderQuota {
  provider: string;
  quota_usd_per_24h?: number;
  quota_tokens_per_24h?: number;
}
```

to:

```typescript
export interface ProviderQuota {
  provider: string;
  model?: string;
  quota_usd_per_24h?: number;
  quota_tokens_per_24h?: number;
  quota_tokens_per_5h?: number;
}
```

- [ ] **Step 5: Pass model through `loadProviderQuotas`**

In `packages/daemon/src/agentchat-config.ts:25-32`, change:

```typescript
export function loadProviderQuotas(path: string): ProviderQuota[] {
  const cfg = loadAgentChatConfig(path);
  return cfg.providers.map((p) => ({
    provider: p.name,
    quota_usd_per_24h: p.quota_usd_per_24h,
    quota_tokens_per_24h: p.quota_tokens_per_24h,
  }));
}
```

to:

```typescript
export function loadProviderQuotas(path: string): ProviderQuota[] {
  const cfg = loadAgentChatConfig(path);
  return cfg.providers.map((p) => ({
    provider: p.name,
    model: p.model,
    quota_usd_per_24h: p.quota_usd_per_24h,
    quota_tokens_per_24h: p.quota_tokens_per_24h,
    quota_tokens_per_5h: p.quota_tokens_per_5h,
  }));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/agentchat/test/config/load.test.ts`
Expected: PASS, both new tests + existing tests.

- [ ] **Step 7: Typecheck across packages**

Run: `bun run typecheck`
Expected: 0 errors. The `ProviderQuota` interface change is additive (all new fields optional), so no callers break.

- [ ] **Step 8: Commit**

```bash
git add packages/agentchat/src/config/types.ts packages/agentchat/test/config/load.test.ts packages/core/src/readers/cost-quota.ts packages/daemon/src/agentchat-config.ts
git commit -m "feat(config): per-model quota fields on ProviderQuotaConfig"
```

---

## Task 6: Per-(provider, model) aggregation in `recentCost` and `quotaStatus`

**Files:**
- Modify: `packages/core/src/readers/cost.ts`
- Modify: `packages/core/src/readers/cost-quota.ts`
- Test: `packages/core/test/readers/cost.test.ts`
- Test: `packages/core/test/readers/cost-quota.test.ts`

- [ ] **Step 1: Write the failing test for cost.ts**

Add to `packages/core/test/readers/cost.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '../../src/db/migrations.js';
import { recentCost } from '../../src/readers/cost.js';
import { writeT0Event } from '../../src/writers/t0.js';

function fixedClock(iso: string) {
  return () => new Date(iso);
}

describe('recentCost.by_provider_model', () => {
  it('aggregates token usage per (provider, model) tuple', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const clock = fixedClock('2026-04-29T12:00:00Z');
    const base = {
      ts: '2026-04-29T11:30:00Z',
      source: 'agentchat' as const,
      source_detail: 'otlp',
      user_id: 'u', machine_id: 'm', session_id: 's',
      event_type: 'usage-update' as const,
      lane: 'cloud' as const,
      cost_usd: null, latency_ms: null,
      payload_json: { used: 100 },
    };
    writeT0Event(db, { ...base, provider: 'google', model: 'gemini-3-flash-preview', tokens_in: 100, tokens_out: 5, request_id: 'r1' }, clock);
    writeT0Event(db, { ...base, provider: 'google', model: 'gemini-3-flash-preview', tokens_in: 200, tokens_out: 10, request_id: 'r2' }, clock);
    writeT0Event(db, { ...base, provider: 'google', model: 'gemini-3.1-pro-preview', tokens_in: 50, tokens_out: 20, request_id: 'r3' }, clock);

    const out = recentCost(db, { since: '2026-04-29T11:00:00Z' }, clock);
    expect(out.by_provider_model).toBeDefined();
    const flash = out.by_provider_model!.find((r) => r.model === 'gemini-3-flash-preview');
    const pro = out.by_provider_model!.find((r) => r.model === 'gemini-3.1-pro-preview');
    expect(flash).toMatchObject({ provider: 'google', model: 'gemini-3-flash-preview', handoff_count: 2 });
    expect(pro).toMatchObject({ provider: 'google', model: 'gemini-3.1-pro-preview', handoff_count: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/readers/cost.test.ts -t "by_provider_model"`
Expected: FAIL — `by_provider_model` is undefined on the result.

- [ ] **Step 3: Extend `RecentCostOutput` and the SQL**

In `packages/core/src/readers/cost.ts`, change the interface:

```typescript
export interface RecentCostOutput {
  total_cost_usd: number | null;
  total_tokens_used: number;
  handoff_count: number;
  by_provider: Array<{
    provider: string | null;
    cost_usd: number | null;
    tokens_used: number;
    handoff_count: number;
  }>;
  by_provider_model: Array<{
    provider: string | null;
    model: string | null;
    cost_usd: number | null;
    tokens_used: number;
    handoff_count: number;
  }>;
  window: { from: string; to: string };
}
```

In the same file, after the existing `byProviderRows` query, add:

```typescript
  const byProviderModelRows = db.prepare(`
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        model,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider, model
    )
    SELECT
      provider,
      model,
      SUM(handoff_cost_usd) AS cost_usd,
      SUM(handoff_tokens)   AS tokens_used,
      COUNT(*)              AS handoff_count
    FROM per_handoff
    GROUP BY provider, model
    ORDER BY (cost_usd IS NULL) ASC, cost_usd DESC, tokens_used DESC
  `).all(since, input.projectId ?? null, input.projectId ?? null) as Array<{
    provider: string | null;
    model: string | null;
    cost_usd: number | null;
    tokens_used: number | null;
    handoff_count: number;
  }>;
```

Then in the return statement, add:

```typescript
    by_provider_model: byProviderModelRows.map(r => ({
      provider: r.provider,
      model: r.model,
      cost_usd: r.cost_usd,
      tokens_used: r.tokens_used ?? 0,
      handoff_count: r.handoff_count,
    })),
```

- [ ] **Step 4: Run cost test to verify it passes**

Run: `bun test packages/core/test/readers/cost.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for cost-quota.ts**

Add to `packages/core/test/readers/cost-quota.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyMigrations } from '../../src/db/migrations.js';
import { quotaStatus } from '../../src/readers/cost-quota.js';
import { writeT0Event } from '../../src/writers/t0.js';

function fixedClock(iso: string) { return () => new Date(iso); }

describe('quotaStatus per-model', () => {
  it('reports a row per (provider, model) tuple when model is set in quota config', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const clock = fixedClock('2026-04-29T12:00:00Z');
    const base = {
      ts: '2026-04-29T11:30:00Z',
      source: 'agentchat' as const, source_detail: 'otlp',
      user_id: 'u', machine_id: 'm', session_id: 's',
      event_type: 'usage-update' as const, lane: 'cloud' as const,
      cost_usd: null, latency_ms: null,
      payload_json: { used: 100 },
    };
    writeT0Event(db, { ...base, provider: 'google', model: 'gemini-3-flash-preview', tokens_in: 100, tokens_out: 5, request_id: 'r1' }, clock);
    writeT0Event(db, { ...base, provider: 'google', model: 'gemini-3.1-pro-preview', tokens_in: 50, tokens_out: 20, request_id: 'r2' }, clock);

    const out = quotaStatus(db, [
      { provider: 'google', model: 'gemini-3-flash-preview', quota_tokens_per_24h: 1000 },
      { provider: 'google', model: 'gemini-3.1-pro-preview', quota_tokens_per_24h: 200 },
    ], { since: '2026-04-29T11:00:00Z' }, clock);

    expect(out.providers).toHaveLength(2);
    const flash = out.providers.find((p) => p.model === 'gemini-3-flash-preview')!;
    const pro = out.providers.find((p) => p.model === 'gemini-3.1-pro-preview')!;
    expect(flash.used_tokens).toBe(100);
    expect(flash.quota_tokens).toBe(1000);
    expect(pro.used_tokens).toBe(50);
    expect(pro.quota_tokens).toBe(200);
  });

  it('still aggregates by provider when no model field is set on the quota row', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const clock = fixedClock('2026-04-29T12:00:00Z');
    const base = {
      ts: '2026-04-29T11:30:00Z',
      source: 'agentchat' as const, source_detail: 'otlp',
      user_id: 'u', machine_id: 'm', session_id: 's',
      event_type: 'usage-update' as const, lane: 'cloud' as const,
      cost_usd: null, latency_ms: null,
      payload_json: { used: 100 },
    };
    writeT0Event(db, { ...base, provider: 'anthropic', model: 'claude-opus', tokens_in: 100, tokens_out: 5, request_id: 'r1' }, clock);
    writeT0Event(db, { ...base, provider: 'anthropic', model: 'claude-sonnet', tokens_in: 50, tokens_out: 20, request_id: 'r2' }, clock);

    const out = quotaStatus(db, [
      { provider: 'anthropic', quota_tokens_per_24h: 10000 },
    ], { since: '2026-04-29T11:00:00Z' }, clock);

    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]!.provider).toBe('anthropic');
    expect(out.providers[0]!.model).toBeUndefined();
    expect(out.providers[0]!.used_tokens).toBe(150);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test packages/core/test/readers/cost-quota.test.ts -t "per-model"`
Expected: FAIL — `quotaStatus` ignores the `model` field.

- [ ] **Step 7: Extend `quotaStatus` and `QuotaStatusProviderRow`**

In `packages/core/src/readers/cost-quota.ts`, add `model?: string` to `QuotaStatusProviderRow`:

```typescript
export interface QuotaStatusProviderRow {
  provider: string;
  model?: string;
  used_usd: number | null;
  quota_usd: number | null;
  remaining_usd: number | null;
  remaining_pct_usd: number | null;
  used_tokens: number;
  quota_tokens: number | null;
  remaining_tokens: number | null;
  remaining_pct_tokens: number | null;
}
```

Replace the body of `quotaStatus` to keep model-less entries on the existing path and add a model-keyed path:

```typescript
export function quotaStatus(
  db: Database,
  providers: ProviderQuota[],
  input: QuotaStatusInput,
  now: () => Date,
): QuotaStatusOutput {
  const recent = recentCost(db, { since: input.since }, now);

  const usageByProvider = new Map<string, { cost_usd: number | null; tokens_used: number }>();
  for (const row of recent.by_provider) {
    if (row.provider == null) continue;
    usageByProvider.set(row.provider, { cost_usd: row.cost_usd, tokens_used: row.tokens_used });
  }
  const usageByProviderModel = new Map<string, { cost_usd: number | null; tokens_used: number }>();
  for (const row of recent.by_provider_model) {
    if (row.provider == null) continue;
    const k = `${row.provider}\0${row.model ?? ''}`;
    usageByProviderModel.set(k, { cost_usd: row.cost_usd, tokens_used: row.tokens_used });
  }

  const out: QuotaStatusProviderRow[] = providers.map((p) => {
    const usage = p.model
      ? (usageByProviderModel.get(`${p.provider}\0${p.model}`) ?? { cost_usd: null, tokens_used: 0 })
      : (usageByProvider.get(p.provider) ?? { cost_usd: null, tokens_used: 0 });

    const used_usd = p.quota_usd_per_24h !== undefined ? (usage.cost_usd ?? 0) : null;
    const quota_usd = p.quota_usd_per_24h ?? null;
    const remaining_usd = (used_usd !== null && quota_usd !== null) ? Math.max(0, quota_usd - used_usd) : null;
    const remaining_pct_usd = (remaining_usd !== null && quota_usd !== null && quota_usd > 0)
      ? Math.round((remaining_usd / quota_usd) * 1000) / 10
      : null;

    const used_tokens = usage.tokens_used;
    const quota_tokens = p.quota_tokens_per_24h ?? null;
    const remaining_tokens = quota_tokens !== null ? Math.max(0, quota_tokens - used_tokens) : null;
    const remaining_pct_tokens = (remaining_tokens !== null && quota_tokens !== null && quota_tokens > 0)
      ? Math.round((remaining_tokens / quota_tokens) * 1000) / 10
      : null;

    const row: QuotaStatusProviderRow = {
      provider: p.provider,
      used_usd, quota_usd, remaining_usd, remaining_pct_usd,
      used_tokens, quota_tokens, remaining_tokens, remaining_pct_tokens,
    };
    if (p.model) row.model = p.model;
    return row;
  });

  return { window: recent.window, providers: out };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test packages/core/test/readers/cost-quota.test.ts`
Expected: PASS — both new tests + all existing tests.

- [ ] **Step 9: Run all core tests**

Run: `bun test packages/core`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/readers/cost.ts packages/core/src/readers/cost-quota.ts packages/core/test/readers/cost.test.ts packages/core/test/readers/cost-quota.test.ts
git commit -m "feat(core): per-(provider,model) aggregation in cost + quotaStatus"
```

---

## Task 7: Capacity-error tracker in cli-spawn

**Files:**
- Modify: `packages/agentchat/src/adapters/cli-spawn.ts`
- Test: `packages/agentchat/test/adapters/cli-spawn.test.ts`

- [ ] **Step 1: Read cli-spawn current shape**

Run: `grep -n "stderr\|return.*text\|throw" packages/agentchat/src/adapters/cli-spawn.ts`
Expected: confirms where stderr is captured (line ~99) and where successful results return.

- [ ] **Step 2: Decide where to detect**

The pattern `RetryableQuotaError: No capacity available` is found in stderr regardless of exit code. Detection should happen after `stderr` is available, before the function returns.

The CapturePort or PenumbraClient (used elsewhere in agentchat to emit events) is the emission target. Look for the existing pattern:

Run: `grep -rn "emit.*usage-update\|capturePort\|usageUpdate" packages/agentchat/src 2>/dev/null | head -10`
Expected: shows how other modules push events into the daemon.

If cli-spawn doesn't already have a CapturePort dependency, **emit via `console.log` only** for this task, and defer the event emission to a follow-up. Specifically: detect, log, and add a counter to the returned object. We'll wire the actual T0 event in T7 step 6 below by extending the SpawnOpts callback.

- [ ] **Step 3: Write the failing test**

Add to `packages/agentchat/test/adapters/cli-spawn.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { detectCapacityError } from '../../src/adapters/cli-spawn.js';

describe('detectCapacityError', () => {
  it('extracts provider+model from gemini stderr', () => {
    const stderr = 'gemini: RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview\n';
    expect(detectCapacityError(stderr)).toEqual({
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      raw: 'No capacity available for model gemini-3.1-pro-preview',
    });
  });
  it('returns null when no capacity error is present', () => {
    expect(detectCapacityError('some normal error\n')).toBeNull();
    expect(detectCapacityError('')).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/agentchat/test/adapters/cli-spawn.test.ts -t "detectCapacityError"`
Expected: FAIL — function not exported.

- [ ] **Step 5: Implement and export the detector**

In `packages/agentchat/src/adapters/cli-spawn.ts`, add (above `spawnCliAdapter` or in an appropriate location):

```typescript
const CAPACITY_PATTERNS: Array<{ provider: string; re: RegExp }> = [
  { provider: 'google', re: /No capacity available for model ([\w.\-]+)/ },
];

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

export function detectCapacityError(stderr: string): CapacityError | null {
  if (!stderr) return null;
  for (const p of CAPACITY_PATTERNS) {
    const m = stderr.match(p.re);
    if (m) {
      return { provider: p.provider, model: m[1] ?? null, raw: m[0] };
    }
  }
  return null;
}
```

- [ ] **Step 6: Wire emission via existing post-spawn hook**

In `spawnCliAdapter`, after stderr is captured (around line 99-101) and before the function returns, add:

```typescript
        const capErr = detectCapacityError(stderr);
        if (capErr && opts.onCapacityError) {
          opts.onCapacityError(capErr);
        }
```

Add to the `SpawnOpts` interface (locate it in the same file):

```typescript
export interface SpawnOpts {
  // ... existing fields ...
  /** Optional callback fired when a vendor capacity-error pattern is detected in stderr. */
  onCapacityError?: (err: CapacityError) => void;
}
```

- [ ] **Step 7: Wire the callback in cli-spawn callers**

Find all call sites:

Run: `grep -rn "spawnCliAdapter" packages/agentchat/src 2>/dev/null`

For each caller that has access to a `CapturePort` (or `PenumbraClient`), pass:

```typescript
onCapacityError: (err) => {
  void capturePort.emitEvent({
    event_type: 'provider-capacity-error',
    provider: err.provider,
    model: err.model,
    payload_json: { raw: err.raw },
  });
},
```

(The exact emission API is whatever the existing CapturePort exposes — match the surface used by the usage-poller. Read `packages/agentchat/src/usage-readers/poller.ts` to confirm the event-emission shape.)

- [ ] **Step 8: Run all agentchat tests**

Run: `bun test packages/agentchat`
Expected: PASS, including the 2 new `detectCapacityError` tests.

- [ ] **Step 9: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add packages/agentchat/src/adapters/cli-spawn.ts packages/agentchat/test/adapters/cli-spawn.test.ts
git commit -m "feat(agentchat): detect provider capacity errors in cli-spawn stderr"
```

---

## Task 8: `penumbra hooks install --gemini-otel` subcommand

**Files:**
- Modify: `packages/cli/src/commands/hooks.ts`
- Test: `packages/cli/test/commands/hooks.test.ts`
- Modify: `packages/cli/bin/penumbra.ts:121-150` (subcommand router)

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/commands/hooks.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooksInstallGeminiOtel, runHooksUninstallGeminiOtel } from '../../src/commands/hooks.js';

function makeFakeHome(): { home: string; geminiDir: string; portFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
  const geminiDir = join(home, '.gemini');
  mkdirSync(geminiDir, { recursive: true });
  const portFile = join(home, 'penumbra-port');
  writeFileSync(portFile, '51390');
  return { home, geminiDir, portFile };
}

describe('runHooksInstallGeminiOtel', () => {
  it('writes telemetry block into ~/.gemini/settings.json with the daemon port', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    const r = await runHooksInstallGeminiOtel({ geminiDir, portFile });
    expect(r.installed).toBe(true);
    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf8'));
    expect(settings.telemetry).toMatchObject({
      enabled: true,
      target: 'local',
      otlpProtocol: 'http',
      otlpEndpoint: 'http://localhost:51390',
    });
  });

  it('preserves existing settings.json keys', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ theme: 'Dark', selectedAuthType: 'oauth-personal' }, null, 2));
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('Dark');
    expect(settings.selectedAuthType).toBe('oauth-personal');
    expect(settings.telemetry?.otlpEndpoint).toBe('http://localhost:51390');
  });

  it('is idempotent when settings already match', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const r2 = await runHooksInstallGeminiOtel({ geminiDir, portFile });
    expect(r2.idempotent).toBe(true);
    expect(r2.installed).toBe(false);
  });

  it('throws when port file is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
    const geminiDir = join(home, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    await expect(runHooksInstallGeminiOtel({ geminiDir, portFile: join(home, 'missing') })).rejects.toThrow(/port/i);
  });
});

describe('runHooksUninstallGeminiOtel', () => {
  it('removes the telemetry block we wrote', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const r = await runHooksUninstallGeminiOtel({ geminiDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf8'));
    expect(settings.telemetry).toBeUndefined();
  });

  it('returns removed=false when no telemetry block exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
    const geminiDir = join(home, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ theme: 'Dark' }));
    const r = await runHooksUninstallGeminiOtel({ geminiDir });
    expect(r.removed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/commands/hooks.test.ts -t "GeminiOtel"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the install/uninstall**

Add to `packages/cli/src/commands/hooks.ts`:

```typescript
export interface InstallGeminiOtelOpts {
  geminiDir?: string;
  portFile?: string;
}

export interface InstallGeminiOtelResult {
  installed: boolean;
  idempotent?: boolean;
  endpoint: string;
}

export async function runHooksInstallGeminiOtel(opts: InstallGeminiOtelOpts = {}): Promise<InstallGeminiOtelResult> {
  const geminiDir = opts.geminiDir ?? join(homedir(), '.gemini');
  const portFile = opts.portFile ?? '/tmp/penumbra-live/port';
  if (!existsSync(portFile)) {
    throw new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`);
  }
  const port = readFileSync(portFile, 'utf8').trim();
  const endpoint = `http://localhost:${port}`;

  mkdirSync(geminiDir, { recursive: true });
  const settingsPath = join(geminiDir, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};

  const desired = {
    enabled: true,
    target: 'local',
    otlpProtocol: 'http',
    otlpEndpoint: endpoint,
    traces: false,
  };
  const current = settings.telemetry;
  const matches = current
    && current.enabled === desired.enabled
    && current.target === desired.target
    && current.otlpProtocol === desired.otlpProtocol
    && current.otlpEndpoint === desired.otlpEndpoint;
  if (matches) {
    return { installed: false, idempotent: true, endpoint };
  }
  settings.telemetry = { ...(current ?? {}), ...desired };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, endpoint };
}

export interface UninstallGeminiOtelOpts {
  geminiDir?: string;
}
export interface UninstallGeminiOtelResult {
  removed: boolean;
}

export async function runHooksUninstallGeminiOtel(opts: UninstallGeminiOtelOpts = {}): Promise<UninstallGeminiOtelResult> {
  const geminiDir = opts.geminiDir ?? join(homedir(), '.gemini');
  const settingsPath = join(geminiDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.telemetry) return { removed: false };
  delete settings.telemetry;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/test/commands/hooks.test.ts`
Expected: PASS — 6 new tests + all existing tests.

- [ ] **Step 5: Wire the CLI subcommand**

In `packages/cli/bin/penumbra.ts`, in the `case 'hooks':` block (around line 121), update the install/uninstall handlers to support `--gemini-otel`:

```typescript
    case 'hooks': {
      const sub = positional[1];
      const flags = new Set(positional.slice(2));
      const force = flags.has('--force-replace');
      const isClaude = flags.has('--claude');
      const isGeminiOtel = flags.has('--gemini-otel');
      const {
        runHooksInstallClaude, runHooksUninstallClaude, runHooksStatus,
        runHooksInstallGeminiOtel, runHooksUninstallGeminiOtel,
      } = await import('../src/commands/hooks.js');

      if (sub === 'install') {
        if (isGeminiOtel) {
          const r = await runHooksInstallGeminiOtel();
          console.log(r.idempotent ? `penumbra hooks: gemini OTel already configured (${r.endpoint})` : `penumbra hooks: gemini OTel installed → ${r.endpoint}`);
          return;
        }
        if (!isClaude) {
          console.error('usage: penumbra hooks install (--claude [--force-replace] | --gemini-otel)');
          process.exit(2);
        }
        const r = await runHooksInstallClaude({ force });
        console.log(r.idempotent ? 'penumbra hooks: already installed' : `penumbra hooks: installed statusline at ${r.scriptPath}`);
        if (r.backupPath) console.log(`penumbra hooks: backed up previous settings to ${r.backupPath}`);
        return;
      }
      if (sub === 'uninstall') {
        if (isGeminiOtel) {
          const r = await runHooksUninstallGeminiOtel();
          console.log(r.removed ? 'penumbra hooks: removed gemini OTel telemetry block' : 'penumbra hooks: no gemini OTel telemetry block found');
          return;
        }
        if (!isClaude) {
          console.error('usage: penumbra hooks uninstall (--claude | --gemini-otel)');
          process.exit(2);
        }
        const r = await runHooksUninstallClaude();
        console.log(r.removed ? 'penumbra hooks: removed statusLine from settings.json' : 'penumbra hooks: no penumbra statusLine found');
        return;
      }
      if (sub === 'status') {
        await runHooksStatus();
        return;
      }
      console.error('usage: penumbra hooks <install|uninstall|status> (--claude | --gemini-otel) [--force-replace]');
      process.exit(2);
    }
```

(Adapt the structure to match the existing router shape — preserve the original variable names like `positional`, `flags` if they differ.)

- [ ] **Step 6: Manual smoke**

Run:
```bash
bun packages/cli/bin/penumbra.ts hooks install --gemini-otel
```

Expected: prints `penumbra hooks: gemini OTel installed → http://localhost:<port>` and `~/.gemini/settings.json` has a `telemetry` block. Inspect with: `cat ~/.gemini/settings.json | jq .telemetry`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/hooks.ts packages/cli/test/commands/hooks.test.ts packages/cli/bin/penumbra.ts
git commit -m "feat(cli): penumbra hooks install --gemini-otel"
```

---

## Task 9: Live verification + docs + memory

**Files:**
- Modify: `~/.config/agentchat/agentchat.yaml` (operator-side)
- Modify: `docs/agent-fleet.md`
- Create: memory entry for OTLP receiver architecture

This task is maestro hand-edited — operator-side, no agent dispatch.

- [ ] **Step 1: Add per-model google quotas to operator yaml**

Edit `~/.config/agentchat/agentchat.yaml`. In the `providers:` block, add (per Google's published Gemini free-tier limits — adjust if your tier differs):

```yaml
providers:
  # ... existing entries ...
  - name: google
    model: gemini-3-flash-preview
    quota_tokens_per_24h: 1500000
  - name: google
    model: gemini-3.1-pro-preview
    quota_tokens_per_24h: 250000
    quota_tokens_per_5h: 50000
```

- [ ] **Step 2: Restart daemon to pick up the new providers config**

```bash
kill $(cat /tmp/penumbra-live/pid)
sleep 1
bun packages/cli/bin/penumbra.ts start &
sleep 2
curl -s -H "Authorization: Bearer $(cat /tmp/penumbra-live/token)" http://localhost:$(cat /tmp/penumbra-live/port)/usage/quota_status | jq .providers
```

Expected: response includes `provider: google, model: gemini-3-flash-preview` and `provider: google, model: gemini-3.1-pro-preview` rows.

- [ ] **Step 3: Install the gemini OTel hook**

```bash
bun packages/cli/bin/penumbra.ts hooks install --gemini-otel
cat ~/.gemini/settings.json | jq .telemetry
```

Expected: `telemetry.otlpEndpoint` matches `http://localhost:<daemon-port>`.

- [ ] **Step 4: Issue a real gemini call**

```bash
echo "what is 17*23?" | gemini -m gemini-3-flash-preview --approval-mode yolo
```

Expected: gemini answers `391`. Within ~2 seconds, the daemon should have ingested at least one usage-update event.

- [ ] **Step 5: Verify ingestion**

```bash
curl -s -H "Authorization: Bearer $(cat /tmp/penumbra-live/token)" "http://localhost:$(cat /tmp/penumbra-live/port)/usage/recent?since=$(date -u -v-5M +%FT%TZ)" | jq '.by_provider_model'
```

Expected: at least one row with `provider: google` and `model: gemini-3-flash-preview`.

- [ ] **Step 6: Verify quota delta**

```bash
curl -s -H "Authorization: Bearer $(cat /tmp/penumbra-live/token)" "http://localhost:$(cat /tmp/penumbra-live/port)/usage/quota_status" | jq '.providers[] | select(.provider=="google")'
```

Expected: `used_tokens > 0` for the model that was just called.

- [ ] **Step 7: Update docs**

In `docs/agent-fleet.md`, add a section under the Phase 3b cost capture documentation:

```markdown
### Phase 3c — OTLP receiver (Path B)

The penumbra daemon accepts OpenTelemetry GenAI-conventions OTLP/JSON over HTTP at:
- `POST /v1/logs` — ingests `gen_ai.client.inference.operation.details` log records as usage-update events
- `POST /v1/metrics` — accepted-and-discarded (logs path is canonical)
- `POST /v1/traces` — accepted-and-discarded

To enable for gemini-cli: `penumbra hooks install --gemini-otel`. Rerun after every daemon restart (port changes).

PII redaction: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` are stripped from the persisted payload.
```

- [ ] **Step 8: Write memory entry**

Save to `/Users/acordeiro/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/project_phase_3c_otlp_receiver.md`:

```markdown
---
name: Phase 3c OTLP receiver architecture and gotchas
description: penumbra daemon as local OpenTelemetry collector — JSON-only, log-record canonical, PII-stripped, port follows daemon
type: project
---

Phase 3c shipped the daemon as a local OTel receiver for GenAI-conventions telemetry.

**Why:** Per-tool readers (Phase 3b: ClaudeJsonl, OpenCodeDb, CodexRollout, ClaudeStatusLine) don't scale to N tools. OTel GenAI conventions are an emerging cross-vendor standard. Build once.

**How to apply:**
- New tool that exports OTel GenAI metrics → just point its OTLP exporter at the daemon's port. No new reader.
- Existing per-tool readers (Phase 3b) remain canonical for their tools — don't deprecate yet; OTel adoption isn't universal.
- Operator must re-run `penumbra hooks install --gemini-otel` after daemon port change. Port lives in `/tmp/penumbra-live/port`.

**Gotchas:**
- Gemini-cli emits OTLP/**JSON** when `OTLP_PROTOCOL=http` (no protobuf decoder needed).
- Logs path (`gen_ai.client.inference.operation.details`) is canonical — metrics histogram duplicates it. Metrics route accepts-and-discards.
- PII keys (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`) are stripped before persistence.
- Provider mapping: `gcp.vertex_ai` → `google`. Unknown providers pass through as-is.
- OTLP routes mounted BEFORE bearer-auth gate; rely on daemon's 127.0.0.1 bind for isolation.
- Capacity-error tracker (`provider-capacity-error` event) pattern-matches cli-spawn stderr for `RetryableQuotaError: No capacity available`.
```

- [ ] **Step 9: Commit docs + push**

```bash
git add docs/agent-fleet.md
git commit -m "docs(phase-3c): OTLP receiver path documented"
git push origin main
```

---

## Self-Review

### Spec coverage

Covered from the handoff doc 10-task sketch:
- T1 schema additions → Task 1 (provider-capacity-error) + Task 5 (per-model quota fields)
- T2 protobuf decoder → **dropped per probe**; replaced by Task 2 (JSON parser)
- T3 /v1/metrics route → Task 4
- T4 /v1/logs route → Task 4
- T5 auth decision → Task 4 step 6 (mounted before bearer-auth gate, localhost-bind only)
- T6 normalizer → Task 3 (with PII redaction)
- T7 hooks install --gemini-otel → Task 8
- T8 per-model quota schema → Task 5 + Task 6
- T9 capacity-error tracker → Task 7
- T10 live verification + docs + memory → Task 9

### Placeholder scan

- No "TBD" / "TODO" / "implement later" in steps.
- One conditional in Task 4 step 4: "verify writeT0Event export" — this is an explicit verification step, not a placeholder. The plan tells the engineer how to find the actual symbol name and align.
- One conditional in Task 7 step 7: "match the surface used by the usage-poller" — this is because the CapturePort emission shape is the existing pattern; the plan tells the engineer where to read for the canonical example.

### Type consistency

- `provider-capacity-error` event_type literal used identically in T1, T7.
- `ProviderQuota.model` field added in T5, consumed in T6, written by T9.
- `RecentCostOutput.by_provider_model` defined in T6, consumed in `quotaStatus` (T6).
- `CapacityError` interface defined and exported in T7 step 5; same shape used in T7 step 6.
- `InstallGeminiOtelResult.endpoint` defined in T8 step 3; used in T8 step 5.

---

## Phase 3d follow-up (deferred — DO NOT include in this PR)

Reference notes for the next phase, captured here so the rationale doesn't get lost between sessions.

### Codex normalizer (`codex.sse_event`)
Per [PR 2103](https://github.com/openai/codex/pull/2103): the `codex.sse_event` log record carries token counts on completion events. Attributes:
- `service.name = "codex-cli"`, `model`, `slug` (resource attrs)
- `event.kind` (`completion` for the one with usage)
- `input_token_count`, `output_token_count`, optional `cached_token_count`, `reasoning_token_count`, `tool_token_count`

Handler stub for the `LOG_HANDLERS` registry:
```typescript
LOG_HANDLERS['codex.sse_event'] = (rec) => {
  if (asString(rec.attrs['event.kind']) !== 'completion') return null;
  const tokensIn = asNumber(rec.attrs['input_token_count']);
  const tokensOut = asNumber(rec.attrs['output_token_count']);
  // provider is implicit from service.name; codex talks to OpenAI by default
  // but model may be claude/gemini under chat-completions adapter — leave it null
  return { /* ... usage-update event ... */ };
};
```

Hooks install:
- `penumbra hooks install --codex-otel` writes `[otel]` block to `~/.codex/config.toml` with `exporter.otlp-http.endpoint = "http://localhost:<daemon-port>"` and `protocol = "binary"` (codex defaults to protobuf).
- This unblocks the protobuf path requirement.

### Claude Code / Agent SDK normalizer
Likely uses GenAI conventions per Anthropic's pattern, but exact event names need probing. Set up a session with:
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<probe-port>
```
Then capture and decode protobuf bodies (need the protobuf decoder added to Phase 3d). Span names will be `claude_code.interaction|llm_request|tool|hook`. Token counts are likely on `claude_code.llm_request` spans/events.

Hooks install:
- `penumbra hooks install --claude-otel` writes the `OTEL_*` env vars into `~/.claude/settings.json` `env` block (per the observability docs).

### OTLP/protobuf support
Add `@bufbuild/protobuf` (or hand-roll a partial parser focused on GenAI + custom event log records). Wire into `otlpLogsRoute` content-type dispatch:
- `application/json` → existing JSON.parse path
- `application/x-protobuf` → protobuf parse → same `ParsedLogRecord[]` output

Once protobuf works, codex and claude-code can ingest without each operator needing to flip their exporter to JSON.

### Per-tool capacity-error patterns
Extend `CAPACITY_PATTERNS` in cli-spawn:
- OpenAI: `429 Too Many Requests` with body containing `rate_limit_exceeded`
- Anthropic: `overloaded_error` JSON
- Add as encountered

### Deprecation roadmap for per-tool readers
Once Phase 3d ships, the Phase 3b readers become candidates for retirement:
- `ClaudeJsonlReader` — superseded by claude-code OTel logs
- `OpenCodeDbReader` — keep until opencode ships #12142
- `CodexRolloutReader` — keep for rate-limit snapshots (codex OTel doesn't expose rate-limit windows yet)
- `ClaudeStatusLineBridge` — keep for rate-limit windows (orthogonal to usage)

Don't deprecate eagerly. Keep readers running side-by-side until the OTel path is proven to capture the same data.
