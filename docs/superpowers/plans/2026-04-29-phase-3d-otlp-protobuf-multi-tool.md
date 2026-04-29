# Phase 3d — OTLP/protobuf Decoder + Codex & Claude-Code Handlers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase 3c OTLP receiver to ingest token usage from `codex` and `claude-code`, both of which default to OTLP/protobuf. Add a hand-rolled protobuf wire-format reader (no dependency), per-tool handlers in the `LOG_HANDLERS` registry, and `penumbra hooks install --codex-otel` / `--claude-otel` subcommands.

**Architecture:** A minimal protobuf wire reader (`packages/core/src/otlp/protobuf.ts`) decodes the few message types we need from raw bytes — varints, length-delimited fields, fixed64. A second envelope walker (`parseOtlpLogsProtobuf`) consumes those bytes and produces the same `ParsedLogRecord[]` shape the existing JSON parser yields, so the downstream `LOG_HANDLERS` registry and T0 ingest pipeline are unchanged. The `otlpLogsRoute` dispatches on `Content-Type` (`application/json` → existing JSON parser, `application/x-protobuf` → new protobuf parser). Two new handlers in the registry — `codex.sse_event` (filter to `event.kind == 'completion'`, emit usage-update with provider=openai) and `claude_code.api_request` (emit usage-update with provider=anthropic + cost_usd from the log record). Two new hooks subcommands write the right config blob for each tool.

**Tech Stack:** Bun runtime, TypeScript, hand-rolled protobuf wire-format reader (no `@bufbuild/protobuf` dependency), GenAI conventions (gemini, Phase 3c) plus tool-specific event schemas (codex `codex.sse_event`, claude-code `claude_code.api_request`).

**Probe captures (operator-side, NOT committed to repo):** `/tmp/otlp-probe-3d/00{02..07}-.body.bin` (codex), `00{08..13}-v1_*.body.bin` (claude-code). These contain real PII (user account IDs, emails) and **must NOT be moved to repo**. Test fixtures will be generated programmatically by a test-helper protobuf encoder.

---

## Probe-Validated Findings (locked, do not relitigate)

### Codex (codex-cli/0.125.0)
- **Wire**: `application/x-protobuf` only (no JSON option)
- **Endpoint convention**: codex sends to **whatever URL you configure, no path appending** — operator must include `/v1/logs` in the endpoint URL. Otherwise codex POSTs to `/`.
- **Per-call traffic**: 6+ bodies, mix of logs (small) and traces (large, from `tracing-rs` auto-instrumentation). We ingest logs only.
- **Canonical event**: `event.name = "codex.sse_event"` log records with `event.kind = "completion"` carry usage:
  - `input_token_count`, `output_token_count` (required)
  - `cached_token_count`, `reasoning_token_count`, `tool_token_count` (optional)
  - `model` (canonical, e.g. `gpt-5.4`)
  - `conversation.id` (use as session linkage)
- **Resource attrs**: `service.name = "codex-cli"`, `service.version`, `app.version`, `user.account_id` (when authenticated)
- **Provider mapping**: `service.name = "codex-cli"` → provider = `openai` (codex defaults to OpenAI; if user configures alternate provider, it'll be in resource attrs eventually but isn't in current schema)

### Claude-code (claude/2.1.123)
- **Wire**: `application/x-protobuf` (default; gRPC also possible but we ignore)
- **Endpoint convention**: claude-code follows **standard OTLP/HTTP paths** — `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>` makes it append `/v1/logs` and `/v1/metrics` itself.
- **Per-call traffic**: ~6 bodies (4 logs + 2 metrics for a non-trace-enabled session)
- **Canonical event**: `event.name = "claude_code.api_request"` log records carry usage:
  - `input_tokens`, `output_tokens` (required)
  - `cache_creation_tokens`, `cache_read_tokens` (when applicable)
  - `cost_usd` (provided directly — claude-code is the only tool we know that exports cost)
  - `model` (e.g. `claude-haiku-4-5`)
  - `prompt.id` (use as request_id)
  - `session.id`
- **Resource attrs**: `service.name = "claude-code"`, `service.version`, `user.account_id`, `user.account_uuid`, `user.email`, `user.id`
- **Other log events** (NOT canonical for usage): `claude_code.hook_execution_{start,complete}`, `claude_code.mcp_server_connection`, `claude_code.api_error` — discard.
- **Provider mapping**: `service.name = "claude-code"` → provider = `anthropic`

### Both share
- Custom event-name namespaces (`codex.*` and `claude_code.*`), **NOT** GenAI semantic conventions
- Resource attribute schema follows OTel conventions
- Both POST raw protobuf with no compression header (`content-encoding: null`)

---

## File Structure

**Created:**
- `packages/core/src/otlp/protobuf.ts` — hand-rolled wire-format reader (varint, length-delimited, fixed64) + `parseOtlpLogsProtobuf(bytes: Uint8Array): ParsedLogRecord[]`
- `packages/core/test/otlp/protobuf.test.ts` — round-trip tests using a small encoder helper
- `packages/core/test/otlp/encoder.ts` — test-only protobuf encoder that constructs valid OTLP logs envelopes for fixture generation

**Modified:**
- `packages/core/src/otlp/normalize.ts` — add 2 handlers to `LOG_HANDLERS`: `codex.sse_event` and `claude_code.api_request`. Provider mapping for codex/claude-code service names.
- `packages/core/test/otlp/normalize.test.ts` — append 4-6 tests for the new handlers
- `packages/core/src/index.ts` — export `parseOtlpLogsProtobuf`
- `packages/daemon/src/routes/otlp.ts` — `otlpLogsRoute` dispatches by `Content-Type`: JSON → existing path; protobuf → new parse + same downstream
- `packages/daemon/test/routes/otlp.test.ts` — append protobuf-content-type test
- `packages/cli/src/commands/hooks.ts` — add `runHooksInstall/UninstallCodexOtel`, `runHooksInstall/UninstallClaudeOtel`
- `packages/cli/test/commands/hooks.test.ts` — append tests for both
- `packages/cli/bin/penumbra.ts` — extend `hooks install/uninstall` flag handling for `--codex-otel`, `--claude-otel`
- `docs/agent-fleet.md` — append Phase 3d note (extends the Phase 3c section)

**Operator-side (T8, manual):**
- `~/.codex/config.toml` — `[otel]` block written by `penumbra hooks install --codex-otel`
- `~/.claude/settings.json` — `env` block written by `penumbra hooks install --claude-otel`

---

## Task Routing

| Task | Suggested agent | Why |
|---|---|---|
| T1 protobuf reader | `oc-deepseek-v4-pro` or `gemini` | Substantive, bit-level, edge cases |
| T2 protobuf logs envelope walker | `oc-mimo-v2.5-pro` | Fixture-driven, mirrors T2 of Phase 3c |
| T3 content-type dispatch | `codex-mini` | Mechanical 4-line edit + 1 test |
| T4 codex handler | `codex-mini` | Small, surgical, registry insert + tests |
| T5 claude-code handler | `codex-mini` | Same |
| T6 hooks --codex-otel | `oc-mimo-v2.5-pro` | TOML edit + tests, mirrors gemini-otel pattern |
| T7 hooks --claude-otel | `oc-mimo-v2.5-pro` | JSON env edit + tests |
| T8 live verification | maestro hand-edit | Operator-side dispatch + check |

Two-round cap. Maestro hand-edits round-3+. Don't tell agents to restart the worker.

---

# Tasks

## Task 1: Hand-rolled protobuf wire reader

**Files:**
- Create: `packages/core/src/otlp/protobuf.ts`
- Create: `packages/core/test/otlp/protobuf.test.ts`
- Create: `packages/core/test/otlp/encoder.ts` (test-only encoder helper)

**Background:** OTLP/protobuf bodies use the standard protobuf wire format (https://protobuf.dev/programming-guides/encoding/). We need to read three wire types:
- **Varint** (wire type 0) — ZigZag-decoded for signed; raw for unsigned/enum/bool
- **Length-delimited** (wire type 2) — bytes / strings / nested messages
- **Fixed64** (wire type 1) — for `timeUnixNano`, `intValue`, `doubleValue` (when used)

We do NOT need: fixed32 (wire type 5), groups (wire types 3+4, deprecated). If a field with one of these types appears, skip it (read varint length and advance, or skip 4 bytes for fixed32).

### Step 1: Define the reader interface and types

Create `packages/core/src/otlp/protobuf.ts`:

```typescript
/**
 * Minimal protobuf wire-format reader. Handles the three wire types used by
 * the OTLP logs envelope: varint (0), fixed64 (1), length-delimited (2).
 * Skip-only support for fixed32 (5). Throws on unknown wire types.
 *
 * Reference: https://protobuf.dev/programming-guides/encoding/
 */
export class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean { return this.pos >= this.buf.length; }
  get position(): number { return this.pos; }

  /** Read a varint as a JS number (truncates beyond 53 bits). */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (this.pos >= this.buf.length) throw new Error('protobuf: truncated varint');
      byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (shift > 63) throw new Error('protobuf: varint too long');
    } while ((byte & 0x80) !== 0);
    return result;
  }

  /** Read fixed64 as a JS number (loses precision beyond 2^53). */
  readFixed64(): number {
    if (this.pos + 8 > this.buf.length) throw new Error('protobuf: truncated fixed64');
    const lo = (this.buf[this.pos]! | (this.buf[this.pos + 1]! << 8) | (this.buf[this.pos + 2]! << 16) | (this.buf[this.pos + 3]! << 24)) >>> 0;
    const hi = (this.buf[this.pos + 4]! | (this.buf[this.pos + 5]! << 8) | (this.buf[this.pos + 6]! << 16) | (this.buf[this.pos + 7]! << 24)) >>> 0;
    this.pos += 8;
    return hi * Math.pow(2, 32) + lo;
  }

  /** Read fixed64 as a string of decimal digits (preserves precision). */
  readFixed64AsString(): string {
    if (this.pos + 8 > this.buf.length) throw new Error('protobuf: truncated fixed64');
    let lo = BigInt(0);
    let hi = BigInt(0);
    for (let i = 0; i < 4; i++) lo |= BigInt(this.buf[this.pos + i]!) << BigInt(8 * i);
    for (let i = 0; i < 4; i++) hi |= BigInt(this.buf[this.pos + 4 + i]!) << BigInt(8 * i);
    this.pos += 8;
    return ((hi << BigInt(32)) | lo).toString();
  }

  readLengthDelimited(): Uint8Array {
    const len = this.readVarint();
    if (this.pos + len > this.buf.length) throw new Error('protobuf: truncated length-delimited');
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readString(): string {
    return new TextDecoder('utf-8').decode(this.readLengthDelimited());
  }

  /**
   * Skip a single field whose tag has just been read. Caller passes the
   * wire type. Used to advance past unknown fields without breaking the cursor.
   */
  skipField(wireType: number): void {
    switch (wireType) {
      case 0: this.readVarint(); return;
      case 1: this.pos += 8; return;
      case 2: { const len = this.readVarint(); this.pos += len; return; }
      case 5: this.pos += 4; return;
      default: throw new Error(`protobuf: unknown wire type ${wireType}`);
    }
  }

  /** Read a tag (field number + wire type). Returns null at EOF. */
  readTag(): { fieldNumber: number; wireType: number } | null {
    if (this.eof) return null;
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }
}
```

### Step 2: Write the failing tests

Create `packages/core/test/otlp/encoder.ts` (a tiny encoder used only by tests):

```typescript
/**
 * Minimal protobuf encoder for test fixtures. Encodes only the wire types
 * we need to exercise the reader. Not exported from package.
 */
export class ProtoWriter {
  private parts: number[] = [];

  bytes(): Uint8Array { return new Uint8Array(this.parts); }

  writeVarint(n: number): void {
    while (n > 0x7f) {
      this.parts.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.parts.push(n & 0x7f);
  }

  writeTag(fieldNumber: number, wireType: number): void {
    this.writeVarint((fieldNumber << 3) | wireType);
  }

  writeString(fieldNumber: number, s: string): void {
    this.writeTag(fieldNumber, 2);
    const bytes = new TextEncoder().encode(s);
    this.writeVarint(bytes.length);
    for (const b of bytes) this.parts.push(b);
  }

  writeVarintField(fieldNumber: number, n: number): void {
    this.writeTag(fieldNumber, 0);
    this.writeVarint(n);
  }

  writeFixed64(fieldNumber: number, n: number): void {
    this.writeTag(fieldNumber, 1);
    let lo = n % 0x100000000;
    let hi = Math.floor(n / 0x100000000);
    for (let i = 0; i < 4; i++) { this.parts.push(lo & 0xff); lo = lo >>> 8; }
    for (let i = 0; i < 4; i++) { this.parts.push(hi & 0xff); hi = hi >>> 8; }
  }

  writeNested(fieldNumber: number, nested: Uint8Array): void {
    this.writeTag(fieldNumber, 2);
    this.writeVarint(nested.length);
    for (const b of nested) this.parts.push(b);
  }
}
```

Create `packages/core/test/otlp/protobuf.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { ProtoReader } from '../../src/otlp/protobuf.js';
import { ProtoWriter } from './encoder.js';

describe('ProtoReader.readVarint', () => {
  it('reads single-byte varint', () => {
    const r = new ProtoReader(new Uint8Array([0x05]));
    expect(r.readVarint()).toBe(5);
  });
  it('reads multi-byte varint', () => {
    const r = new ProtoReader(new Uint8Array([0x96, 0x01])); // 150
    expect(r.readVarint()).toBe(150);
  });
  it('roundtrips with encoder', () => {
    const w = new ProtoWriter();
    w.writeVarint(123456789);
    const r = new ProtoReader(w.bytes());
    expect(r.readVarint()).toBe(123456789);
  });
});

describe('ProtoReader.readString', () => {
  it('reads length-delimited UTF-8', () => {
    const w = new ProtoWriter();
    w.writeString(1, 'hello world');
    const r = new ProtoReader(w.bytes());
    const tag = r.readTag()!;
    expect(tag.fieldNumber).toBe(1);
    expect(tag.wireType).toBe(2);
    expect(r.readString()).toBe('hello world');
  });
});

describe('ProtoReader.readFixed64AsString', () => {
  it('preserves nanosecond precision', () => {
    const w = new ProtoWriter();
    w.writeFixed64(1, 1777466989089000000);
    const r = new ProtoReader(w.bytes());
    r.readTag();
    expect(r.readFixed64AsString()).toBe('1777466989089000000');
  });
});

describe('ProtoReader.skipField', () => {
  it('advances past unknown wire types', () => {
    const w = new ProtoWriter();
    w.writeString(1, 'skip me');
    w.writeString(2, 'keep me');
    const r = new ProtoReader(w.bytes());
    r.readTag(); // tag for field 1
    r.skipField(2); // skip length-delimited
    const tag2 = r.readTag()!;
    expect(tag2.fieldNumber).toBe(2);
    expect(r.readString()).toBe('keep me');
  });
});

describe('ProtoReader.readTag at eof', () => {
  it('returns null when buffer is exhausted', () => {
    const r = new ProtoReader(new Uint8Array([]));
    expect(r.readTag()).toBeNull();
  });
});
```

### Step 3: Run tests to verify they fail

Run: `bun test packages/core/test/otlp/protobuf.test.ts`
Expected: FAIL with `Cannot find module '../../src/otlp/protobuf.js'` or similar.

### Step 4: Run tests to verify they pass

After Step 1's `protobuf.ts` is in place:
Run: `bun test packages/core/test/otlp/protobuf.test.ts`
Expected: PASS — 7 tests.

### Step 5: Typecheck

Run: `bun x tsc --build packages/core/tsconfig.json`
Expected: 0 errors.

### Step 6: Commit

```bash
git add packages/core/src/otlp/protobuf.ts packages/core/test/otlp/protobuf.test.ts packages/core/test/otlp/encoder.ts
git commit -m "feat(core): minimal protobuf wire-format reader for OTLP/protobuf"
```

---

## Task 2: OTLP/protobuf logs envelope walker

**Files:**
- Modify: `packages/core/src/otlp/protobuf.ts` (add `parseOtlpLogsProtobuf` function)
- Modify: `packages/core/test/otlp/protobuf.test.ts` (append envelope tests)
- Modify: `packages/core/src/index.ts` (export `parseOtlpLogsProtobuf`)

**Reference (OTel proto field tags):**
```
ExportLogsServiceRequest:
  resourceLogs = field 1 (length-delim)

ResourceLogs:
  resource    = field 1 (length-delim)
  scopeLogs   = field 2 (length-delim, repeated)
  schemaUrl   = field 3 (string, ignore)

Resource:
  attributes  = field 1 (length-delim, repeated)
  droppedAttributesCount = field 2 (varint, ignore)

ScopeLogs:
  scope       = field 1 (length-delim)
  logRecords  = field 2 (length-delim, repeated)
  schemaUrl   = field 3 (string, ignore)

InstrumentationScope:
  name        = field 1 (string)
  version     = field 2 (string, ignore)
  attributes  = field 3 (ignore)

LogRecord:
  timeUnixNano         = field 1 (fixed64)
  observedTimeUnixNano = field 11 (fixed64, ignore)
  severityNumber       = field 2 (varint, ignore)
  severityText         = field 3 (string, ignore)
  body                 = field 5 (length-delim, AnyValue)
  attributes           = field 6 (length-delim, repeated KeyValue)
  droppedAttributesCount = field 7 (varint, ignore)
  flags                = field 8 (fixed32, ignore)
  traceId              = field 9 (bytes, ignore)
  spanId               = field 10 (bytes, ignore)

KeyValue:
  key   = field 1 (string)
  value = field 2 (length-delim, AnyValue)

AnyValue (oneof):
  stringValue = field 1
  boolValue   = field 2 (varint)
  intValue    = field 3 (varint, signed-zigzag in proto3 but emitted as varint)
  doubleValue = field 4 (fixed64)
  arrayValue  = field 5 (length-delim, ArrayValue)
  kvlistValue = field 6 (length-delim, KeyValueList)
  bytesValue  = field 7 (bytes, decode to base64 string for safety)

ArrayValue:
  values = field 1 (length-delim, repeated AnyValue)

KeyValueList:
  values = field 1 (length-delim, repeated KeyValue)
```

### Step 1: Append envelope-walker test

Append to `packages/core/test/otlp/protobuf.test.ts`:

```typescript
import { parseOtlpLogsProtobuf } from '../../src/otlp/protobuf.js';

function encodeKeyValue(key: string, valueEncoder: (w: ProtoWriter) => void): Uint8Array {
  const inner = new ProtoWriter();
  inner.writeString(1, key);
  const valW = new ProtoWriter();
  valueEncoder(valW);
  inner.writeNested(2, valW.bytes());
  return inner.bytes();
}

function stringValue(s: string): (w: ProtoWriter) => void {
  return (w) => w.writeString(1, s);
}

function intValue(n: number): (w: ProtoWriter) => void {
  return (w) => w.writeVarintField(3, n);
}

describe('parseOtlpLogsProtobuf', () => {
  it('parses a minimal logs envelope with one log record', () => {
    // Build attributes
    const resourceAttr = encodeKeyValue('service.name', stringValue('test-service'));
    const logAttr1 = encodeKeyValue('event.name', stringValue('test.event'));
    const logAttr2 = encodeKeyValue('count', intValue(42));

    // Resource (field 1: attributes)
    const resourceMsg = new ProtoWriter();
    resourceMsg.writeNested(1, resourceAttr);

    // Scope (field 1: name)
    const scopeMsg = new ProtoWriter();
    scopeMsg.writeString(1, 'test-scope');

    // LogRecord (field 1: timeUnixNano fixed64, field 6: attributes repeated)
    const logRecord = new ProtoWriter();
    logRecord.writeFixed64(1, 1777466989089000000);
    logRecord.writeNested(6, logAttr1);
    logRecord.writeNested(6, logAttr2);

    // ScopeLogs (field 1: scope, field 2: logRecords)
    const scopeLogs = new ProtoWriter();
    scopeLogs.writeNested(1, scopeMsg.bytes());
    scopeLogs.writeNested(2, logRecord.bytes());

    // ResourceLogs (field 1: resource, field 2: scopeLogs)
    const resourceLogs = new ProtoWriter();
    resourceLogs.writeNested(1, resourceMsg.bytes());
    resourceLogs.writeNested(2, scopeLogs.bytes());

    // ExportLogsServiceRequest (field 1: resourceLogs)
    const envelope = new ProtoWriter();
    envelope.writeNested(1, resourceLogs.bytes());

    const records = parseOtlpLogsProtobuf(envelope.bytes());
    expect(records).toHaveLength(1);
    expect(records[0]!.resourceAttrs['service.name']).toBe('test-service');
    expect(records[0]!.scopeName).toBe('test-scope');
    expect(records[0]!.attrs['event.name']).toBe('test.event');
    expect(records[0]!.attrs['count']).toBe(42);
    // timeUnixNano preserved as string
    expect(records[0]!.timeUnixNano).toBe('1777466989089000000');
  });

  it('returns [] for empty envelope', () => {
    expect(parseOtlpLogsProtobuf(new Uint8Array([]))).toEqual([]);
  });

  it('handles a logs envelope with multiple records and nested kvlistValue', () => {
    // One LogRecord with a kvlistValue attribute
    const inner = new ProtoWriter();
    inner.writeNested(1, encodeKeyValue('nested.key', stringValue('nested-val')));
    const kvlistAttr = encodeKeyValue('outer', (w) => w.writeNested(6, inner.bytes()));

    const logRecord = new ProtoWriter();
    logRecord.writeNested(6, kvlistAttr);

    const scopeLogs = new ProtoWriter();
    scopeLogs.writeNested(2, logRecord.bytes());

    const resourceLogs = new ProtoWriter();
    resourceLogs.writeNested(2, scopeLogs.bytes());

    const envelope = new ProtoWriter();
    envelope.writeNested(1, resourceLogs.bytes());

    const records = parseOtlpLogsProtobuf(envelope.bytes());
    expect(records).toHaveLength(1);
    // kvlistValue is decoded as a flat object
    expect((records[0]!.attrs['outer'] as Record<string, unknown>)['nested.key']).toBe('nested-val');
  });
});
```

### Step 2: Run test to verify it fails

Run: `bun test packages/core/test/otlp/protobuf.test.ts -t "parseOtlpLogsProtobuf"`
Expected: FAIL — `parseOtlpLogsProtobuf` not exported.

### Step 3: Implement the envelope walker

Append to `packages/core/src/otlp/protobuf.ts`:

```typescript
import type { ParsedLogRecord } from './types.js';

type AttrValue = unknown;

function readAnyValue(bytes: Uint8Array): AttrValue {
  const r = new ProtoReader(bytes);
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: return r.readString(); // stringValue
      case 2: return r.readVarint() !== 0; // boolValue
      case 3: return r.readVarint(); // intValue
      case 4: return r.readFixed64(); // doubleValue (truncated to JS number — close enough for our use)
      case 5: { // arrayValue → ArrayValue { repeated AnyValue values = 1 }
        const arrayBytes = r.readLengthDelimited();
        const out: AttrValue[] = [];
        const ar = new ProtoReader(arrayBytes);
        while (!ar.eof) {
          const at = ar.readTag();
          if (!at) break;
          if (at.fieldNumber === 1 && at.wireType === 2) {
            out.push(readAnyValue(ar.readLengthDelimited()));
          } else {
            ar.skipField(at.wireType);
          }
        }
        return out;
      }
      case 6: { // kvlistValue → KeyValueList { repeated KeyValue values = 1 }
        const kvBytes = r.readLengthDelimited();
        const out: Record<string, AttrValue> = {};
        const kr = new ProtoReader(kvBytes);
        while (!kr.eof) {
          const kt = kr.readTag();
          if (!kt) break;
          if (kt.fieldNumber === 1 && kt.wireType === 2) {
            const [k, v] = readKeyValue(kr.readLengthDelimited());
            out[k] = v;
          } else {
            kr.skipField(kt.wireType);
          }
        }
        return out;
      }
      case 7: return r.readLengthDelimited(); // bytesValue
      default: r.skipField(tag.wireType);
    }
  }
  return null;
}

function readKeyValue(bytes: Uint8Array): [string, AttrValue] {
  const r = new ProtoReader(bytes);
  let key = '';
  let value: AttrValue = null;
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) key = r.readString();
    else if (tag.fieldNumber === 2 && tag.wireType === 2) value = readAnyValue(r.readLengthDelimited());
    else r.skipField(tag.wireType);
  }
  return [key, value];
}

function readAttributes(bytesList: Uint8Array[]): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const b of bytesList) {
    const [k, v] = readKeyValue(b);
    if (k) out[k] = v;
  }
  return out;
}

function readScope(bytes: Uint8Array): { name: string | null } {
  const r = new ProtoReader(bytes);
  let name: string | null = null;
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) name = r.readString();
    else r.skipField(tag.wireType);
  }
  return { name };
}

function readResource(bytes: Uint8Array): Record<string, AttrValue> {
  const r = new ProtoReader(bytes);
  const attrs: Uint8Array[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) attrs.push(r.readLengthDelimited());
    else r.skipField(tag.wireType);
  }
  return readAttributes(attrs);
}

function readLogRecord(bytes: Uint8Array, resourceAttrs: Record<string, AttrValue>, scopeName: string | null): ParsedLogRecord {
  const r = new ProtoReader(bytes);
  let timeUnixNano: string | null = null;
  let body: string | null = null;
  const attrBytes: Uint8Array[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 1) timeUnixNano = r.readFixed64AsString();
    else if (tag.fieldNumber === 5 && tag.wireType === 2) {
      const v = readAnyValue(r.readLengthDelimited());
      body = typeof v === 'string' ? v : null;
    }
    else if (tag.fieldNumber === 6 && tag.wireType === 2) attrBytes.push(r.readLengthDelimited());
    else r.skipField(tag.wireType);
  }
  return {
    timeUnixNano,
    resourceAttrs,
    scopeName,
    body,
    attrs: readAttributes(attrBytes),
  };
}

function readScopeLogs(bytes: Uint8Array, resourceAttrs: Record<string, AttrValue>): ParsedLogRecord[] {
  const r = new ProtoReader(bytes);
  let scopeName: string | null = null;
  const records: ParsedLogRecord[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) scopeName = readScope(r.readLengthDelimited()).name;
    else if (tag.fieldNumber === 2 && tag.wireType === 2) {
      records.push(readLogRecord(r.readLengthDelimited(), resourceAttrs, scopeName));
    }
    else r.skipField(tag.wireType);
  }
  return records;
}

function readResourceLogs(bytes: Uint8Array): ParsedLogRecord[] {
  const r = new ProtoReader(bytes);
  let resourceAttrs: Record<string, AttrValue> = {};
  const out: ParsedLogRecord[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) resourceAttrs = readResource(r.readLengthDelimited());
    else if (tag.fieldNumber === 2 && tag.wireType === 2) out.push(...readScopeLogs(r.readLengthDelimited(), resourceAttrs));
    else r.skipField(tag.wireType);
  }
  return out;
}

/**
 * Parse an OTLP/protobuf ExportLogsServiceRequest envelope into the same
 * `ParsedLogRecord[]` shape that `parseOtlpLogs` (the JSON parser) emits.
 * Lossy on rare edge cases (oneof bytesValue, fixed32 fields), but covers
 * everything codex-cli and claude-code emit per probe captures.
 */
export function parseOtlpLogsProtobuf(bytes: Uint8Array): ParsedLogRecord[] {
  if (bytes.length === 0) return [];
  const r = new ProtoReader(bytes);
  const out: ParsedLogRecord[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) out.push(...readResourceLogs(r.readLengthDelimited()));
    else r.skipField(tag.wireType);
  }
  return out;
}
```

### Step 4: Run tests to verify they pass

Run: `bun test packages/core/test/otlp/protobuf.test.ts`
Expected: PASS — 10 tests total (7 from T1, 3 envelope-walker tests).

### Step 5: Export from index.ts

In `packages/core/src/index.ts`, add:

```typescript
export { parseOtlpLogsProtobuf } from './otlp/protobuf.js';
```

(Place near the existing `parseOtlpLogs` export.)

### Step 6: Typecheck + commit

Run: `bun x tsc --build packages/core/tsconfig.json`
Expected: 0 errors.

```bash
git add packages/core/src/otlp/protobuf.ts packages/core/src/index.ts packages/core/test/otlp/protobuf.test.ts
git commit -m "feat(core): OTLP/protobuf logs envelope walker"
```

---

## Task 3: Daemon route content-type dispatch

**Files:**
- Modify: `packages/daemon/src/routes/otlp.ts`
- Modify: `packages/daemon/test/routes/otlp.test.ts`

### Step 1: Append failing test

Append to `packages/daemon/test/routes/otlp.test.ts`:

```typescript
import { parseOtlpLogsProtobuf } from '@penumbra/core';
// (the test below builds a minimal protobuf envelope inline so it doesn't
//  depend on either probe captures or test-only helpers from another package)

describe('otlpLogsRoute protobuf', () => {
  it('accepts application/x-protobuf and ingests usage events', async () => {
    const services = makeServices();

    // Build a minimal OTLP/protobuf logs envelope with one gen_ai inference record.
    // Helper: encodes [tag(fieldNo, wireType), payload].
    const enc = new TextEncoder();
    const w: number[] = [];
    function pushVarint(n: number) { while (n > 0x7f) { w.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } w.push(n & 0x7f); }
    function pushTag(fn: number, wt: number) { pushVarint((fn << 3) | wt); }
    function pushString(fn: number, s: string) { pushTag(fn, 2); const b = enc.encode(s); pushVarint(b.length); for (const x of b) w.push(x); }
    function pushVarintField(fn: number, n: number) { pushTag(fn, 0); pushVarint(n); }
    function pushNested(fn: number, bytes: number[]) { pushTag(fn, 2); pushVarint(bytes.length); w.push(...bytes); }
    function buildKeyValue(key: string, valueFn: () => number[]): number[] {
      const inner: number[] = [];
      const k = enc.encode(key);
      // field 1: key (string)
      inner.push((1 << 3) | 2); { let n = k.length; while (n > 0x7f) { inner.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } inner.push(n & 0x7f); for (const x of k) inner.push(x); }
      // field 2: value (AnyValue)
      const v = valueFn();
      inner.push((2 << 3) | 2); { let n = v.length; while (n > 0x7f) { inner.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } inner.push(n & 0x7f); for (const x of v) inner.push(x); }
      return inner;
    }
    // (Implementation omitted in this comment for brevity — the test must build
    //  a real protobuf body. Reuse the test helper from packages/core/test/otlp/encoder.ts
    //  if it's exposed, or copy ProtoWriter inline. The key assertion is that
    //  Content-Type x-protobuf goes through the new path and ingests a row.)

    // For brevity, use the actual probe envelope shape via the encoder helper:
    const { ProtoWriter } = await import('../../../core/test/otlp/encoder.js');
    function kv(k: string, valueEncoder: (w: ProtoWriter) => void): Uint8Array {
      const i = new ProtoWriter();
      i.writeString(1, k);
      const v = new ProtoWriter();
      valueEncoder(v);
      i.writeNested(2, v.bytes());
      return i.bytes();
    }
    const resourceAttr = kv('service.name', (w) => w.writeString(1, 'gemini-cli'));
    const eventNameAttr = kv('event.name', (w) => w.writeString(1, 'gen_ai.client.inference.operation.details'));
    const providerAttr = kv('gen_ai.provider.name', (w) => w.writeString(1, 'gcp.vertex_ai'));
    const modelAttr = kv('gen_ai.request.model', (w) => w.writeString(1, 'gemini-3-flash-preview'));
    const inAttr = kv('gen_ai.usage.input_tokens', (w) => w.writeVarintField(3, 100));
    const outAttr = kv('gen_ai.usage.output_tokens', (w) => w.writeVarintField(3, 5));

    const resource = new ProtoWriter();
    resource.writeNested(1, resourceAttr);

    const scope = new ProtoWriter();
    scope.writeString(1, 'gemini-cli');

    const logRecord = new ProtoWriter();
    logRecord.writeFixed64(1, 1777466989089000000);
    logRecord.writeNested(6, eventNameAttr);
    logRecord.writeNested(6, providerAttr);
    logRecord.writeNested(6, modelAttr);
    logRecord.writeNested(6, inAttr);
    logRecord.writeNested(6, outAttr);

    const scopeLogs = new ProtoWriter();
    scopeLogs.writeNested(1, scope.bytes());
    scopeLogs.writeNested(2, logRecord.bytes());

    const resourceLogs = new ProtoWriter();
    resourceLogs.writeNested(1, resource.bytes());
    resourceLogs.writeNested(2, scopeLogs.bytes());

    const envelope = new ProtoWriter();
    envelope.writeNested(1, resourceLogs.bytes());

    const req = new Request('http://localhost/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: envelope.bytes(),
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(200);
    const rows = services.db.prepare(`SELECT provider, model FROM t0_events WHERE event_type='usage-update'`).all() as Array<{ provider: string; model: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.provider).toBe('google');
    expect(rows[0]!.model).toBe('gemini-3-flash-preview');
  });
});
```

### Step 2: Run test to verify it fails

Run: `bun test packages/daemon/test/routes/otlp.test.ts -t "protobuf"`
Expected: FAIL with `415 Unsupported Media Type` because `otlpLogsRoute` currently only accepts JSON.

### Step 3: Implement content-type dispatch in otlpLogsRoute

In `packages/daemon/src/routes/otlp.ts`, replace the current `otlpLogsRoute` with:

```typescript
import { parseOtlpLogs, parseOtlpLogsProtobuf, normalizeOtlpLogsToUsageEvents, normalize } from '@penumbra/core';

// ... isJson, makeNormalizeCtx unchanged ...

function isProtobuf(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.includes('application/x-protobuf') || ct.includes('application/protobuf');
}

export async function otlpLogsRoute(req: Request, services: Services): Promise<Response> {
  let records;
  if (isJson(req)) {
    let envelope: unknown;
    try { envelope = await req.json(); }
    catch (e) { return json({ error: { code: 'invalid_json', message: (e as Error).message } }, 400); }
    records = parseOtlpLogs(envelope);
  } else if (isProtobuf(req)) {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await req.arrayBuffer()); }
    catch (e) { return json({ error: { code: 'invalid_body', message: (e as Error).message } }, 400); }
    try { records = parseOtlpLogsProtobuf(bytes); }
    catch (e) { return json({ error: { code: 'invalid_protobuf', message: (e as Error).message } }, 400); }
  } else {
    return json({ error: { code: 'unsupported_media_type', message: 'OTLP/HTTP route requires application/json or application/x-protobuf' } }, 415);
  }

  const inputs = normalizeOtlpLogsToUsageEvents(records);
  const ctx = makeNormalizeCtx(services);
  for (const input of inputs) {
    const event = normalize(input, ctx);
    services.t0Writer.write(event);
  }
  return json({ accepted: inputs.length });
}
```

Mirror the same dispatch in `otlpMetricsRoute` and `otlpTracesRoute` (accept-and-discard for both content types).

### Step 4: Run tests

Run: `bun test packages/daemon/test/routes/otlp.test.ts`
Expected: PASS — all existing tests + new protobuf test.

### Step 5: Run daemon test suite for regressions

Run: `bun test packages/daemon`
Expected: PASS, no regressions.

### Step 6: Typecheck + commit

```bash
git add packages/daemon/src/routes/otlp.ts packages/daemon/test/routes/otlp.test.ts
git commit -m "feat(daemon): accept application/x-protobuf on /v1/logs"
```

Also: this commit changes the route handler — daemon must be restarted (in T8) before live verification.

---

## Task 4: Codex log handler (`codex.sse_event`)

**Files:**
- Modify: `packages/core/src/otlp/normalize.ts`
- Modify: `packages/core/test/otlp/normalize.test.ts`

### Step 1: Append failing test

Append to `packages/core/test/otlp/normalize.test.ts`:

```typescript
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
  });

  it('skips non-completion sse_event records (in-progress chunks)', () => {
    const records = [{
      timeUnixNano: '1', resourceAttrs: {}, scopeName: 'x', body: null,
      attrs: { 'event.name': 'codex.sse_event', 'event.kind': 'response_part' },
    }];
    expect(normalizeOtlpLogsToUsageEvents(records)).toHaveLength(0);
  });
});
```

### Step 2: Run test to verify it fails

Run: `bun test packages/core/test/otlp/normalize.test.ts -t "codex.sse_event"`
Expected: FAIL — handler not registered in `LOG_HANDLERS`.

### Step 3: Add the handler

In `packages/core/src/otlp/normalize.ts`, extend `LOG_HANDLERS`:

```typescript
// Add to PROVIDER_MAP:
const PROVIDER_MAP: Record<string, string> = {
  'gcp.vertex_ai': 'google',
  'gcp.gemini_api': 'google',
};

// Service-name → provider fallback (used when gen_ai.provider.name is absent):
const SERVICE_TO_PROVIDER: Record<string, string> = {
  'codex-cli': 'openai',
  'claude-code': 'anthropic',
  'gemini-cli': 'google',
};

function providerFromRecord(rec: ParsedLogRecord): string | null {
  const fromAttr = mapProvider(asString(rec.attrs['gen_ai.provider.name']));
  if (fromAttr) return fromAttr;
  const svc = asString(rec.resourceAttrs['service.name']);
  if (svc && SERVICE_TO_PROVIDER[svc]) return SERVICE_TO_PROVIDER[svc];
  return null;
}

// Add to LOG_HANDLERS:
LOG_HANDLERS['codex.sse_event'] = (rec) => {
  if (asString(rec.attrs['event.kind']) !== 'completion') return null;
  const provider = providerFromRecord(rec) ?? 'openai';
  const model = asString(rec.attrs['model']);
  const tokensIn = asNumber(rec.attrs['input_token_count']);
  const tokensOut = asNumber(rec.attrs['output_token_count']);
  const sessionId = asString(rec.attrs['conversation.id']);
  const ts = nanoToIso(rec.timeUnixNano);
  const payload: Record<string, unknown> = {
    ...redact(rec.attrs),
    ...redact(rec.resourceAttrs, 'resource.'),
    used: (tokensIn ?? 0) + (tokensOut ?? 0),
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
};
```

(Move the `handleGenAiInferenceLog` function ABOVE the `LOG_HANDLERS` declaration if needed, and refactor it to use `providerFromRecord` so all three handlers share that helper.)

### Step 4: Run tests

Run: `bun test packages/core/test/otlp/normalize.test.ts`
Expected: PASS — both new tests + all existing tests.

### Step 5: Typecheck + commit

```bash
git add packages/core/src/otlp/normalize.ts packages/core/test/otlp/normalize.test.ts
git commit -m "feat(core): codex.sse_event handler in OTLP normalizer registry"
```

---

## Task 5: Claude-code log handler (`claude_code.api_request`)

**Files:**
- Modify: `packages/core/src/otlp/normalize.ts`
- Modify: `packages/core/test/otlp/normalize.test.ts`

### Step 1: Append failing test

Append to `packages/core/test/otlp/normalize.test.ts`:

```typescript
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
  });

  it('skips claude_code log events that are not api_request (hooks, mcp, errors)', () => {
    const records = [
      { timeUnixNano: '1', resourceAttrs: {}, scopeName: 'x', body: null, attrs: { 'event.name': 'claude_code.hook_execution_start' } },
      { timeUnixNano: '2', resourceAttrs: {}, scopeName: 'x', body: null, attrs: { 'event.name': 'claude_code.mcp_server_connection' } },
    ];
    expect(normalizeOtlpLogsToUsageEvents(records)).toHaveLength(0);
  });
});
```

### Step 2-5: same pattern as T4

Implementation in `packages/core/src/otlp/normalize.ts`:

```typescript
LOG_HANDLERS['claude_code.api_request'] = (rec) => {
  const provider = providerFromRecord(rec) ?? 'anthropic';
  const model = asString(rec.attrs['model']);
  const tokensIn = asNumber(rec.attrs['input_tokens']);
  const tokensOut = asNumber(rec.attrs['output_tokens']);
  const costUsd = asNumber(rec.attrs['cost_usd']);
  const sessionId = asString(rec.attrs['session.id']) ?? asString(rec.resourceAttrs['session.id']);
  const requestId = asString(rec.attrs['prompt.id']);
  const ts = nanoToIso(rec.timeUnixNano);
  const payload: Record<string, unknown> = {
    ...redact(rec.attrs),
    ...redact(rec.resourceAttrs, 'resource.'),
    used: (tokensIn ?? 0) + (tokensOut ?? 0),
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
};
```

Run tests, typecheck, commit:

```bash
git add packages/core/src/otlp/normalize.ts packages/core/test/otlp/normalize.test.ts
git commit -m "feat(core): claude_code.api_request handler in OTLP normalizer"
```

---

## Task 6: `penumbra hooks install --codex-otel`

**Files:**
- Modify: `packages/cli/src/commands/hooks.ts` — add `runHooksInstall/UninstallCodexOtel`
- Modify: `packages/cli/test/commands/hooks.test.ts` — append tests
- Modify: `packages/cli/bin/penumbra.ts` — extend the `case 'hooks':` block for `--codex-otel`

### Step 1: Test

Append to `packages/cli/test/commands/hooks.test.ts` — test that:
- `runHooksInstallCodexOtel({ codexDir, portFile })` writes a `[otel]` block into `~/.codex/config.toml` with `endpoint = "http://localhost:<port>/v1/logs"`, `protocol = "binary"`
- Existing config.toml content is preserved (use TOML round-tripping or string append with markers)
- Idempotent on second invocation (returns `idempotent: true`)
- Throws when port file is missing
- Uninstall removes the block by line markers

(Mirror the gemini-otel test structure from Phase 3c.)

### Step 2: Implementation

In `packages/cli/src/commands/hooks.ts`:

```typescript
const CODEX_OTEL_HEADER = '# penumbra: managed [otel] block — do not edit between markers';
const CODEX_OTEL_FOOTER = '# penumbra: end managed [otel] block';

export interface InstallCodexOtelOpts {
  codexDir?: string;
  portFile?: string;
}
export interface InstallCodexOtelResult {
  installed: boolean;
  idempotent?: boolean;
  endpoint: string;
}

export async function runHooksInstallCodexOtel(opts: InstallCodexOtelOpts = {}): Promise<InstallCodexOtelResult> {
  const codexDir = opts.codexDir ?? join(homedir(), '.codex');
  const portFile = opts.portFile ?? '/tmp/penumbra-live/port';
  if (!existsSync(portFile)) {
    throw new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`);
  }
  const port = readFileSync(portFile, 'utf8').trim();
  const endpoint = `http://localhost:${port}/v1/logs`;
  const block = [
    CODEX_OTEL_HEADER,
    `[otel]`,
    `environment = "penumbra"`,
    `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "binary" } }`,
    CODEX_OTEL_FOOTER,
    '',
  ].join('\n');

  mkdirSync(codexDir, { recursive: true });
  const configPath = join(codexDir, 'config.toml');
  let current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  // Strip any pre-existing managed block.
  const stripped = stripManagedBlock(current, CODEX_OTEL_HEADER, CODEX_OTEL_FOOTER);
  if (stripped === current && current.includes(`endpoint = "${endpoint}"`)) {
    return { installed: false, idempotent: true, endpoint };
  }
  const next = (stripped.endsWith('\n') || stripped === '' ? stripped : stripped + '\n') + '\n' + block;
  writeFileSync(configPath, next);
  return { installed: true, endpoint };
}

export interface UninstallCodexOtelOpts { codexDir?: string; }
export interface UninstallCodexOtelResult { removed: boolean; }

export async function runHooksUninstallCodexOtel(opts: UninstallCodexOtelOpts = {}): Promise<UninstallCodexOtelResult> {
  const codexDir = opts.codexDir ?? join(homedir(), '.codex');
  const configPath = join(codexDir, 'config.toml');
  if (!existsSync(configPath)) return { removed: false };
  const current = readFileSync(configPath, 'utf8');
  const stripped = stripManagedBlock(current, CODEX_OTEL_HEADER, CODEX_OTEL_FOOTER);
  if (stripped === current) return { removed: false };
  writeFileSync(configPath, stripped);
  return { removed: true };
}

function stripManagedBlock(content: string, header: string, footer: string): string {
  const lines = content.split('\n');
  const headerIdx = lines.indexOf(header);
  if (headerIdx < 0) return content;
  const footerIdx = lines.indexOf(footer, headerIdx);
  if (footerIdx < 0) return content;
  const before = lines.slice(0, headerIdx);
  const after = lines.slice(footerIdx + 1);
  // Trim trailing blank line that we added when we wrote the block, if present.
  while (before.length > 0 && before[before.length - 1] === '') before.pop();
  while (after.length > 0 && after[0] === '') after.shift();
  return [...before, ...(after.length ? [''] : []), ...after].join('\n');
}
```

### Step 3: Wire CLI subcommand

In `packages/cli/bin/penumbra.ts`, add `--codex-otel` to the install/uninstall flag dispatch (mirrors the gemini-otel pattern). Update the usage strings.

### Step 4: Manual smoke

```bash
bun packages/cli/bin/penumbra.ts hooks install --codex-otel
grep -A4 "penumbra: managed" ~/.codex/config.toml
bun packages/cli/bin/penumbra.ts hooks uninstall --codex-otel
grep -c "penumbra: managed" ~/.codex/config.toml || echo "block removed"
```

### Step 5: Commit

```bash
git add packages/cli/src/commands/hooks.ts packages/cli/test/commands/hooks.test.ts packages/cli/bin/penumbra.ts
git commit -m "feat(cli): penumbra hooks install --codex-otel"
```

---

## Task 7: `penumbra hooks install --claude-otel`

**Files:** same files as T6.

### Step 1-5: mirror T6 with these differences

- Settings file: `~/.claude/settings.json` (the existing claude-statusLine hook from Phase 3b T18 lives in this file too — preserve)
- Block to write: an `env` block with the OTel env vars

```typescript
const CLAUDE_OTEL_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

export async function runHooksInstallClaudeOtel(opts: { claudeDir?: string; portFile?: string } = {}): Promise<{ installed: boolean; idempotent?: boolean; endpoint: string }> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const portFile = opts.portFile ?? '/tmp/penumbra-live/port';
  if (!existsSync(portFile)) throw new Error(`penumbra hooks: daemon port file ${portFile} not found`);
  const port = readFileSync(portFile, 'utf8').trim();
  const endpoint = `http://localhost:${port}`;
  const desired = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  settings.env = settings.env ?? {};
  const current = settings.env;
  const matches = CLAUDE_OTEL_KEYS.every((k) => current[k] === desired[k]);
  if (matches) return { installed: false, idempotent: true, endpoint };
  for (const k of CLAUDE_OTEL_KEYS) settings.env[k] = desired[k];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, endpoint };
}

export async function runHooksUninstallClaudeOtel(opts: { claudeDir?: string } = {}): Promise<{ removed: boolean }> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.env) return { removed: false };
  let removed = false;
  for (const k of CLAUDE_OTEL_KEYS) {
    if (k in settings.env) { delete settings.env[k]; removed = true; }
  }
  if (Object.keys(settings.env).length === 0) delete settings.env;
  if (!removed) return { removed: false };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true };
}
```

Tests + smoke + commit.

---

## Task 8: Live verification + docs + memory

This task is maestro hand-edited.

- [ ] Restart daemon (T3 changed `serve.ts` route handler — daemon must reload). After restart, all OTLP routes accept both JSON and protobuf.
- [ ] `bun packages/cli/bin/penumbra.ts hooks install --codex-otel` and verify `~/.codex/config.toml` has the managed `[otel]` block with the correct endpoint.
- [ ] `bun packages/cli/bin/penumbra.ts hooks install --claude-otel` and verify `~/.claude/settings.json` has the new `env` keys.
- [ ] Run a real codex call: `codex exec --skip-git-repo-check -c 'mcp_servers={}' "what is 5+7? answer with only the number"` — expect `tokens_in/tokens_out` ingested with `provider=openai, model=<codex's model>` in the cost ledger.
- [ ] Run a real claude-code call: `echo "what is 9*11" | claude -p --model haiku` — expect a row with `provider=anthropic, cost_usd != null`.
- [ ] Confirm `bun packages/cli/bin/penumbra.ts cost recent --since 5m` shows both new rows under `by_provider_model`.
- [ ] Confirm `bun packages/cli/bin/penumbra.ts cost quota` shows the per-provider rows correctly.
- [ ] Update `packages/agentchat/docs/agent-fleet.md`: append a Phase 3d note to the existing Phase 3c "OTLP receiver" section listing the three tools now supported (gemini, codex, claude-code) and the protobuf vs JSON content-type matrix.
- [ ] Write memory entry `project_phase_3d_otlp_protobuf.md`: protobuf decoder strategy (hand-rolled), per-tool event-name mapping, hooks UX gotcha (codex's URL-as-is vs claude-code's path-appending), and PII redaction status (resource attrs include user.email for claude-code — flag if this should be added to PII_KEYS).
- [ ] `git push origin main`.

---

## Self-Review

### Spec coverage

- T1 (protobuf reader) + T2 (envelope walker): protobuf path
- T3 (route dispatch): protobuf accepted at /v1/logs
- T4 (codex handler): codex.sse_event → openai
- T5 (claude-code handler): claude_code.api_request → anthropic + cost_usd
- T6/T7 (hooks): operator config for both tools
- T8 (verification): live end-to-end check + docs + memory

### PII concern (flag for follow-up)

Claude-code's resource attrs include `user.email`, `user.account_id`, `user.account_uuid`, `user.id`. The Phase 3c `PII_KEYS` set (`gen_ai.input.messages` etc.) doesn't cover these. They land in `payload_json` under `resource.user.email`/`resource.user.id`. **Decision needed:** extend `PII_KEYS` to include `user.email` and similar identifiers? Or accept that the local-only DB is fine to hold them (already true for the user's own machine_id)? Surface in T8 memory entry.

### Type consistency

- `parseOtlpLogsProtobuf` produces `ParsedLogRecord[]` — same shape as `parseOtlpLogs` (T2 of Phase 3c). Downstream `LOG_HANDLERS` registry consumes the same shape.
- `providerFromRecord` helper added in T4 is shared across all 3 handlers (gemini/codex/claude-code).
- `runHooksInstallCodexOtel` / `runHooksInstallClaudeOtel` mirror the existing `runHooksInstallGeminiOtel` shape — return `{ installed, idempotent?, endpoint }`.

### What's NOT in this phase (deferred to Phase 3e or later)

- Capacity-error → CapturePort emission (T7 of Phase 3c left a callback; wiring it to a T0 event requires extending `NotificationEvent` union — separate task)
- OTLP traces ingestion as `agent-thought`/span events
- Cost-data normalization for openai (codex's `model` is `gpt-5.4` etc.; we don't have provider-side per-model price tables — leave `cost_usd: null` and rely on external price-table import)
