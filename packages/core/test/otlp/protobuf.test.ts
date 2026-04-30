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
    w.writeFixed64(1, 1777466989089000000n);
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

function doubleValue(n: number): (w: ProtoWriter) => void {
  return (w) => w.writeDouble64(4, n);
}

describe('parseOtlpLogsProtobuf', () => {
  it('parses a minimal logs envelope with one log record', () => {
    const resourceAttr = encodeKeyValue('service.name', stringValue('test-service'));
    const logAttr1 = encodeKeyValue('event.name', stringValue('test.event'));
    const logAttr2 = encodeKeyValue('count', intValue(42));

    const resourceMsg = new ProtoWriter();
    resourceMsg.writeNested(1, resourceAttr);

    const scopeMsg = new ProtoWriter();
    scopeMsg.writeString(1, 'test-scope');

    const logRecord = new ProtoWriter();
    logRecord.writeFixed64(1, 1777466989089000000n);
    logRecord.writeNested(6, logAttr1);
    logRecord.writeNested(6, logAttr2);

    const scopeLogs = new ProtoWriter();
    scopeLogs.writeNested(1, scopeMsg.bytes());
    scopeLogs.writeNested(2, logRecord.bytes());

    const resourceLogs = new ProtoWriter();
    resourceLogs.writeNested(1, resourceMsg.bytes());
    resourceLogs.writeNested(2, scopeLogs.bytes());

    const envelope = new ProtoWriter();
    envelope.writeNested(1, resourceLogs.bytes());

    const records = parseOtlpLogsProtobuf(envelope.bytes());
    expect(records).toHaveLength(1);
    expect(records[0]!.resourceAttrs['service.name']).toBe('test-service');
    expect(records[0]!.scopeName).toBe('test-scope');
    expect(records[0]!.attrs['event.name']).toBe('test.event');
    expect(records[0]!.attrs['count']).toBe(42);
    expect(records[0]!.timeUnixNano).toBe('1777466989089000000');
  });

  it('returns [] for empty envelope', () => {
    expect(parseOtlpLogsProtobuf(new Uint8Array([]))).toEqual([]);
  });

  it('handles a logs envelope with nested kvlistValue', () => {
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
    expect((records[0]!.attrs['outer'] as Record<string, unknown>)['nested.key']).toBe('nested-val');
  });

  it('decodes AnyValue double_value fields as IEEE-754 doubles', () => {
    const logAttr = encodeKeyValue('cost_usd', doubleValue(0.00123));

    const logRecord = new ProtoWriter();
    logRecord.writeNested(6, logAttr);

    const scopeLogs = new ProtoWriter();
    scopeLogs.writeNested(2, logRecord.bytes());

    const resourceLogs = new ProtoWriter();
    resourceLogs.writeNested(2, scopeLogs.bytes());

    const envelope = new ProtoWriter();
    envelope.writeNested(1, resourceLogs.bytes());

    const records = parseOtlpLogsProtobuf(envelope.bytes());
    expect(records).toHaveLength(1);
    expect(records[0]!.attrs['cost_usd']).toBe(0.00123);
  });
});
