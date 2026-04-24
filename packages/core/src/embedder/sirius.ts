import type { Embedder } from './interface.js';

export interface SiriusEmbedderOpts {
  baseUrl: string;
  token: string;
  model: string;
  dim: number;
}

/**
 * Remote embedder backed by the sirius-gateway HTTP service.
 *
 * Privacy note: every call to embed() sends the input strings verbatim to
 * `baseUrl` over HTTPS. Callers supplying free-form user queries (e.g. the
 * /recall route) should assume those queries leave the local machine. The
 * in-process RegexRedactor only redacts known sensitive object KEYS inside
 * payloads and does NOT scan free-form strings; upstream layers that care
 * about content-level redaction must handle it before reaching embed().
 */
export class SiriusEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly model: string;

  constructor(opts: SiriusEmbedderOpts) {
    this.name = `sirius:${opts.model}`;
    this.dim = opts.dim;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.model = opts.model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!res.ok) {
      throw new Error(`sirius embeddings: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}
