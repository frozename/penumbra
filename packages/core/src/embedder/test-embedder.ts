import { createHash } from "node:crypto";

import type { Embedder } from "./interface.js";

export class TestEmbedder implements Embedder {
  readonly name = "test";
  readonly dim: number;

  constructor(opts: { dim: number }) {
    this.dim = opts.dim;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.hashToVector(t)));
  }

  private hashToVector(text: string): Float32Array {
    const out = new Float32Array(this.dim);
    let buf = Buffer.from(text, "utf8");
    let i = 0;
    while (i < this.dim) {
      buf = createHash("sha256").update(buf).digest();
      for (let j = 0; j < buf.length && i < this.dim; j += 4) {
        const v = buf.readUInt32BE(j) / 0xffffffff;
        out[i++] = v * 2 - 1;
      }
    }
    let norm = 0;
    for (const value of out) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < out.length; k++) {
      const current = out[k] ?? 0;
      out[k] = current / norm;
    }
    return out;
  }
}
