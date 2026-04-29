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
