import { Database } from "bun:sqlite";

export function checkEmbeddingModelVersion(
  configured: string,
  stored: string | null | undefined,
): string | null {
  if (!stored) return null;
  if (stored === configured) return null;
  return (
    `embedding model version mismatch: configured="${configured}" stored="${stored}"; ` +
    `stored vectors were built with a different model — recall quality may degrade until P7 re-embed runs`
  );
}

export function readStoredEmbeddingModelVersion(db: Database): string | null {
  const row = db
    .query<
      { embedding_model_version: string },
      []
    >("SELECT embedding_model_version FROM t2_memories WHERE embedding_model_version IS NOT NULL LIMIT 1")
    .get();
  return row?.embedding_model_version ?? null;
}
