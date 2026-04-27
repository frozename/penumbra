import type { EmbeddingModel, FlagEmbedding } from 'fastembed';
import type { Embedder } from './interface.js';

type FastembedModule = typeof import('fastembed');

let fastembedModulePromise: Promise<FastembedModule> | null = null;

async function loadFastembed(): Promise<FastembedModule> {
  if (!fastembedModulePromise) {
    fastembedModulePromise = import('fastembed');
  }
  return fastembedModulePromise;
}

export class BundledEmbedder implements Embedder {
  readonly name = 'fastembed-minilm-l6-v2';
  readonly dim = 384;
  private model: FlagEmbedding | null = null;
  private initPromise: Promise<void> | null = null;

  async ready(): Promise<void> {
    if (this.model) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { EmbeddingModel, FlagEmbedding } = await loadFastembed();
        this.model = await FlagEmbedding.init({
          model: EmbeddingModel.AllMiniLML6V2,
        });
      })();
    }
    return this.initPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ready();
    const out: Float32Array[] = [];
    for await (const batch of this.model!.embed(texts, texts.length)) {
      for (const v of batch) out.push(new Float32Array(v));
    }
    return out;
  }
}
