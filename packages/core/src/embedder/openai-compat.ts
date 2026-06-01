import type { Embedder } from "./interface.js";

export interface RemoteEmbedderOpts {
  baseUrl: string;
  model: string;
  dim: number;
  token?: string;
  healthPath?: string;
  authHeader?: string;
  authScheme?: string;
}

/**
 * Remote embedder backed by an OpenAI-compatible HTTP /v1/embeddings endpoint.
 *
 * Privacy note: every call to embed() sends the input strings verbatim to
 * `baseUrl` over HTTPS. Callers supplying free-form user queries (e.g. the
 * /recall route) should assume those queries leave the local machine. The
 * in-process RegexRedactor only redacts known sensitive object KEYS inside
 * payloads and does NOT scan free-form strings; upstream layers that care
 * about content-level redaction must handle it before reaching embed().
 */
export class OpenAICompatEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly model: string;
  private readonly authHeader: string;
  private readonly authScheme: string;

  constructor(opts: RemoteEmbedderOpts) {
    this.name = `openai:${opts.model}`;
    this.dim = opts.dim;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.model = opts.model;
    this.authHeader = opts.authHeader ?? "Authorization";
    this.authScheme = opts.authScheme ?? "Bearer";
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) {
      headers[this.authHeader] = this.authScheme ? `${this.authScheme} ${this.token}` : this.token;
    }

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!res.ok) {
      throw new Error(`openai-compatible embeddings: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}
