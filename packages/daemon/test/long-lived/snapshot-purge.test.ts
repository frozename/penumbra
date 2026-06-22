import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { runSnapshotPurge } from "@penumbra/daemon/long-lived/snapshot-purge";
import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";

describe("runSnapshotPurge", () => {
  it("logs only snapshots older than the ttl in dry-run mode", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const log = mock(() => undefined);

    const result = await runSnapshotPurge({
      db,
      now: 10_000,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      dryRun: true,
      listSnapshots: () =>
        Promise.resolve([
          { id: "snap-old", created_at: 10_000 - 7 * 24 * 60 * 60 * 1000 - 1 },
          { id: "snap-young", created_at: 10_000 - 60_000 },
        ]),
      log,
    });

    expect(result.candidates).toEqual(["snap-old"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("snap-old");
    expect(log.mock.calls[0][0]).not.toContain("snap-young");
  });
});
