import type { FlagEmbedding } from "fastembed";

import type { Embedder } from "./interface.js";

type FastembedModule = typeof import("fastembed");

let fastembedModulePromise: Promise<FastembedModule> | null = null;

async function loadFastembed(): Promise<FastembedModule> {
  fastembedModulePromise ??= import("fastembed");
  return await fastembedModulePromise;
}

export class BundledEmbedder implements Embedder {
  readonly name = "fastembed-minilm-l6-v2";
  readonly dim = 384;
  private model: FlagEmbedding | null = null;
  private initPromise: Promise<void> | null = null;

  async ready(): Promise<void> {
    if (this.model) return;
    this.initPromise ??= (async (): Promise<void> => {
      const { EmbeddingModel, FlagEmbedding } = await loadFastembed();
      this.model = await FlagEmbedding.init({
        model: EmbeddingModel.AllMiniLML6V2,
      });
    })();
    await this.initPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ready();
    const model = this.model;
    if (!model) throw new Error("BundledEmbedder model not initialized");
    const out: Float32Array[] = [];
    for await (const batch of model.embed(texts, texts.length)) {
      for (const v of batch) out.push(new Float32Array(v));
    }
    return out;
  }
}
