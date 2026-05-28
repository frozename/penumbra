import type { Database } from "bun:sqlite";

export interface SnapshotPurgeSnapshot {
  id: string;
  created_at: number;
}

export interface SnapshotPurgeResult {
  candidates: string[];
}

export interface SnapshotPurgeDeps {
  db: Database;
  now: number;
  ttlMs: number;
  dryRun?: boolean;
  listSnapshots: () => Promise<SnapshotPurgeSnapshot[]>;
  log?: (message: string) => void;
}

export async function runSnapshotPurge(deps: SnapshotPurgeDeps): Promise<SnapshotPurgeResult> {
  void deps.db;
  const dryRun = deps.dryRun ?? true;
  const snapshots = await deps.listSnapshots();
  const cutoff = deps.now - deps.ttlMs;
  const candidates = snapshots
    .filter((snapshot) => snapshot.created_at < cutoff)
    .map((snapshot) => snapshot.id);

  if (dryRun && deps.log) {
    deps.log(`snapshot-purge dry-run would delete: ${candidates.join(", ")}`);
  }

  return { candidates };
}
