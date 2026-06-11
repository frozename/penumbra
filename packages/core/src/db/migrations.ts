import { Database } from "bun:sqlite";
import { applySchema, SCHEMA_VERSION } from "./schema.js";
import { DbMeta } from "./meta.js";

export interface MigrateOpts {
  embeddingDim: number;
}

export function assertEmbedderDim(db: Database, embedderDim: number, embedderName?: string): void {
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber("embedding_dim");
  if (storedDim === undefined || storedDim === embedderDim) return;
  const name = embedderName ?? "unknown";
  throw new Error(
    `embedding dim mismatch: embedder '${name}' produces ${embedderDim}-dim vectors but the store is ${storedDim}-dim. Re-embed the corpus or fix PENUMBRA_SIRIUS_DIM/PENUMBRA_EMBEDDINGS_DIM.`,
  );
}

export function migrate(db: Database, opts: MigrateOpts): void {
  applySchema(db, { embeddingDim: opts.embeddingDim });
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber("embedding_dim");
  if (storedDim !== undefined && storedDim !== opts.embeddingDim) {
    throw new Error(
      `embedding_dim mismatch: stored=${storedDim} requested=${opts.embeddingDim}. ` +
        `Run 'penumbra reembed' to change.`,
    );
  }
  meta.set("schema_version", String(SCHEMA_VERSION));
  meta.set("embedding_dim", String(opts.embeddingDim));
}
