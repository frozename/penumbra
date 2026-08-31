import { Database } from "bun:sqlite";

import { DbMeta } from "./meta.js";
import { applySchema, SCHEMA_VERSION } from "./schema.js";

export interface MigrateOpts {
  embeddingDim: number;
}

export function assertEmbedderDim(db: Database, embedderDim: number, embedderName?: string): void {
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber("embedding_dim");
  if (storedDim === undefined || storedDim === embedderDim) return;
  const name = embedderName ?? "unknown";
  throw new Error(
    `embedding dim mismatch: embedder '${name}' produces ${String(embedderDim)}-dim vectors but the store is ${String(storedDim)}-dim. Re-embed the corpus or fix PENUMBRA_EMBEDDINGS_DIM.`,
  );
}

function readStampedSchemaVersion(db: Database): number | undefined {
  const hasMeta = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type='table' AND name='db_meta'")
    .get();
  if (!hasMeta) return undefined;
  return new DbMeta(db).getNumber("schema_version");
}

// applySchema is forward-only: it can add tables/columns but never removes the
// ones a newer build introduced, and a newer build may depend on constraints
// this one cannot express. Refusing beats silently re-stamping the store to an
// older version and corrupting a database an upgraded daemon still owns.
export function assertSchemaNotNewer(db: Database): void {
  const stamped = readStampedSchemaVersion(db);
  if (stamped === undefined || stamped <= SCHEMA_VERSION) return;
  throw new Error(
    `schema_version ${String(stamped)} is newer than this build supports (${String(SCHEMA_VERSION)}). ` +
      `Upgrade penumbra to a build that knows schema ${String(stamped)}; refusing to migrate.`,
  );
}

export function migrate(db: Database, opts: MigrateOpts): void {
  assertSchemaNotNewer(db);
  applySchema(db, { embeddingDim: opts.embeddingDim });
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber("embedding_dim");
  if (storedDim !== undefined && storedDim !== opts.embeddingDim) {
    throw new Error(
      `embedding_dim mismatch: stored=${String(storedDim)} requested=${String(opts.embeddingDim)}. ` +
        `Run 'penumbra reembed' to change.`,
    );
  }
  meta.set("schema_version", String(SCHEMA_VERSION));
  meta.set("embedding_dim", String(opts.embeddingDim));
}
