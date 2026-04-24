import { createHash } from 'node:crypto';
import type { Embedder } from './interface.js';

export class TestEmbedder implements Embedder {
  readonly name = 'test';
  readonly dim: number;

  constructor(opts: { dim: number }) {
    this.dim = opts.dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.hashToVector(t));
  }

  private hashToVector(text: string): Float32Array {
    const out = new Float32Array(this.dim);
    // Use repeated SHA256 rounds to fill the vector deterministically.
    let buf = Buffer.from(text, 'utf8');
    let i = 0;
    while (i < this.dim) {
      buf = createHash('sha256').update(buf).digest();
      for (let j = 0; j < buf.length && i < this.dim; j += 4) {
        const v = buf.readUInt32BE(j) / 0xffffffff; // 0..1
        out[i++] = v * 2 - 1; // -1..1
      }
    }
    // L2-normalize (so cosine sim == dot product later).
    let norm = 0;
    for (let k = 0; k < out.length; k++) norm += out[k]! * out[k]!;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < out.length; k++) out[k] = out[k]! / norm;
    return out;
  }
}
