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

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
  get position(): number {
    return this.pos;
  }

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
    const lo =
      (this.buf[this.pos]! |
        (this.buf[this.pos + 1]! << 8) |
        (this.buf[this.pos + 2]! << 16) |
        (this.buf[this.pos + 3]! << 24)) >>>
      0;
    const hi =
      (this.buf[this.pos + 4]! |
        (this.buf[this.pos + 5]! << 8) |
        (this.buf[this.pos + 6]! << 16) |
        (this.buf[this.pos + 7]! << 24)) >>>
      0;
    this.pos += 8;
    return hi * Math.pow(2, 32) + lo;
  }

  /** Read fixed64 as a string of decimal digits (preserves precision past 2^53). */
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
        throw new Error(`protobuf: unknown wire type ${wireType}`);
    }
  }

  /** Read a tag (field number + wire type). Returns null at EOF. */
  readTag(): { fieldNumber: number; wireType: number } | null {
    if (this.eof) return null;
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }
}
