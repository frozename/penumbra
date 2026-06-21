/**
 * Minimal protobuf wire-format reader. Handles the three wire types used by
 * the OTLP logs envelope: varint (0), fixed64 (1), length-delimited (2).
 * Skip-only support for fixed32 (5). Throws on unknown wire types.
 *
 * Reference: https://protobuf.dev/programming-guides/encoding/
 */
import type { ParsedLogRecord } from "./types.js";

export class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
  get position(): number {
    return this.pos;
  }

  private byteAt(idx: number): number {
    return this.buf[idx] ?? 0;
  }

  /** Read a varint as a JS number (truncates beyond 53 bits). */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (this.pos >= this.buf.length) throw new Error("protobuf: truncated varint");
      byte = this.byteAt(this.pos);
      this.pos++;
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (shift > 63) throw new Error("protobuf: varint too long");
    } while ((byte & 0x80) !== 0);
    return result;
  }

  /** Read fixed64 as a JS number (loses precision beyond 2^53). */
  readFixed64(): number {
    if (this.pos + 8 > this.buf.length) throw new Error("protobuf: truncated fixed64");
    const lo =
      (this.byteAt(this.pos) |
        (this.byteAt(this.pos + 1) << 8) |
        (this.byteAt(this.pos + 2) << 16) |
        (this.byteAt(this.pos + 3) << 24)) >>>
      0;
    const hi =
      (this.byteAt(this.pos + 4) |
        (this.byteAt(this.pos + 5) << 8) |
        (this.byteAt(this.pos + 6) << 16) |
        (this.byteAt(this.pos + 7) << 24)) >>>
      0;
    this.pos += 8;
    return hi * Math.pow(2, 32) + lo;
  }

  readDouble64(): number {
    if (this.pos + 8 > this.buf.length) throw new Error("protobuf: truncated fixed64");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const value = view.getFloat64(0, true);
    this.pos += 8;
    return value;
  }

  /** Read fixed64 as a string of decimal digits (preserves precision past 2^53). */
  readFixed64AsString(): string {
    if (this.pos + 8 > this.buf.length) throw new Error("protobuf: truncated fixed64");
    let lo = BigInt(0);
    let hi = BigInt(0);
    for (let i = 0; i < 4; i++) lo |= BigInt(this.byteAt(this.pos + i)) << BigInt(8 * i);
    for (let i = 0; i < 4; i++) hi |= BigInt(this.byteAt(this.pos + 4 + i)) << BigInt(8 * i);
    this.pos += 8;
    return ((hi << BigInt(32)) | lo).toString();
  }

  readLengthDelimited(): Uint8Array {
    const len = this.readVarint();
    if (this.pos + len > this.buf.length) throw new Error("protobuf: truncated length-delimited");
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readString(): string {
    return new TextDecoder("utf-8").decode(this.readLengthDelimited());
  }

  /**
   * Skip a single field whose tag has just been read. Caller passes the
   * wire type. Used to advance past unknown fields without breaking the cursor.
   *
   * Wire types 3 (START_GROUP) and 4 (END_GROUP) are deprecated proto2 group
   * markers and CANNOT be skipped this way: a START_GROUP has a body (fields
   * between START and matching END) that must be parsed at the parent's
   * nesting level. Treating them as zero-byte advances the cursor into the
   * group body and reads data bytes as field tags, producing spurious wire
   * types (5, 6, 7) deeper in the parse. We throw on groups; the daemon route
   * catches the throw at the envelope level and returns 200 with parse_error
   * so the OTLP exporter doesn't retry-loop. Trace exports from codex-cli
   * occasionally include groups (older proto schemas in tracing-rs deps);
   * those bodies get accepted-and-discarded, which is correct since we don't
   * ingest traces today.
   */
  skipField(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2: {
        const len = this.readVarint();
        this.pos += len;
        return;
      }
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`protobuf: cannot skip wire type ${String(wireType)}`);
    }
  }

  /** Read a tag (field number + wire type). Returns null at EOF. */
  readTag(): { fieldNumber: number; wireType: number } | null {
    if (this.eof) return null;
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }
}

type AttrValue = unknown;

function readArrayValue(arrayBytes: Uint8Array): AttrValue[] {
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

function readKvListValue(kvBytes: Uint8Array): Record<string, AttrValue> {
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

function readAnyValue(bytes: Uint8Array): AttrValue {
  const r = new ProtoReader(bytes);
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1:
        return r.readString();
      case 2:
        return r.readVarint() !== 0;
      case 3:
        return r.readVarint();
      case 4:
        return r.readDouble64();
      case 5:
        return readArrayValue(r.readLengthDelimited());
      case 6:
        return readKvListValue(r.readLengthDelimited());
      case 7:
        return r.readLengthDelimited();
      default:
        r.skipField(tag.wireType);
    }
  }
  return null;
}

function readKeyValue(bytes: Uint8Array): [string, AttrValue] {
  const r = new ProtoReader(bytes);
  let key = "";
  let value: AttrValue = null;
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2) key = r.readString();
    else if (tag.fieldNumber === 2 && tag.wireType === 2)
      value = readAnyValue(r.readLengthDelimited());
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

function readLogRecordField(
  r: ProtoReader,
  tag: { fieldNumber: number; wireType: number },
  state: { timeUnixNano: string | null; body: string | null; attrBytes: Uint8Array[] },
): void {
  if (tag.fieldNumber === 1 && tag.wireType === 1) {
    state.timeUnixNano = r.readFixed64AsString();
  } else if (tag.fieldNumber === 5 && tag.wireType === 2) {
    const v = readAnyValue(r.readLengthDelimited());
    state.body = typeof v === "string" ? v : null;
  } else if (tag.fieldNumber === 6 && tag.wireType === 2) {
    state.attrBytes.push(r.readLengthDelimited());
  } else {
    r.skipField(tag.wireType);
  }
}

function readLogRecord(
  bytes: Uint8Array,
  resourceAttrs: Record<string, AttrValue>,
  scopeName: string | null,
): ParsedLogRecord {
  const r = new ProtoReader(bytes);
  const state: { timeUnixNano: string | null; body: string | null; attrBytes: Uint8Array[] } = {
    timeUnixNano: null,
    body: null,
    attrBytes: [],
  };
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    readLogRecordField(r, tag, state);
  }
  return {
    timeUnixNano: state.timeUnixNano,
    resourceAttrs,
    scopeName,
    body: state.body,
    attrs: readAttributes(state.attrBytes),
  };
}

function readScopeLogs(
  bytes: Uint8Array,
  resourceAttrs: Record<string, AttrValue>,
): ParsedLogRecord[] {
  const r = new ProtoReader(bytes);
  let scopeName: string | null = null;
  const records: ParsedLogRecord[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2)
      scopeName = readScope(r.readLengthDelimited()).name;
    else if (tag.fieldNumber === 2 && tag.wireType === 2) {
      records.push(readLogRecord(r.readLengthDelimited(), resourceAttrs, scopeName));
    } else r.skipField(tag.wireType);
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
    if (tag.fieldNumber === 1 && tag.wireType === 2)
      resourceAttrs = readResource(r.readLengthDelimited());
    else if (tag.fieldNumber === 2 && tag.wireType === 2)
      out.push(...readScopeLogs(r.readLengthDelimited(), resourceAttrs));
    else r.skipField(tag.wireType);
  }
  return out;
}

export function parseOtlpLogsProtobuf(bytes: Uint8Array): ParsedLogRecord[] {
  if (bytes.length === 0) return [];
  const r = new ProtoReader(bytes);
  const out: ParsedLogRecord[] = [];
  while (!r.eof) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === 2)
      out.push(...readResourceLogs(r.readLengthDelimited()));
    else r.skipField(tag.wireType);
  }
  return out;
}
