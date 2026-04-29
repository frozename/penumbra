/**
 * Minimal protobuf encoder for test fixtures. Encodes only the wire types
 * we need to exercise the reader. Not exported from package.
 */
export class ProtoWriter {
  private parts: number[] = [];

  bytes(): Uint8Array {
    return new Uint8Array(this.parts);
  }

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

  writeFixed64(fieldNumber: number, n: number | bigint): void {
    this.writeTag(fieldNumber, 1);
    const val = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    for (let i = 0; i < 8; i++) {
      this.parts.push(Number(val >> (BigInt(8 * i)) & BigInt(0xff)));
    }
  }

  writeNested(fieldNumber: number, nested: Uint8Array): void {
    this.writeTag(fieldNumber, 2);
    this.writeVarint(nested.length);
    for (const b of nested) this.parts.push(b);
  }
}
