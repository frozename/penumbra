import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AaSnapshotStorePayload,
  createAaSnapshotStore,
} from "../../src/routing/aa-snapshot-store.js";

function snapshot(id: string, collectedAt = "2026-08-24T10:00:00.000Z"): AaSnapshotStorePayload {
  return {
    provenance: {
      collectedAt,
      dataVersion: `data-${id}`,
      benchmarkVersion: `bench-${id}`,
    },
    models: [
      {
        id: `aa:model:${id}`,
        name: `Model ${id}`,
        slug: `model-${id}`,
        model_creator: {
          id: `creator:${id}`,
          name: `Creator ${id}`,
          slug: `creator-${id}`,
        },
        evaluations: {
          artificial_analysis_intelligence_index: id === "old" ? 71.2 : 84.9,
          artificial_analysis_coding_index: id === "old" ? 63.4 : 79.1,
          gpqa: id === "old" ? 44.2 : 51.8,
        },
        pricing: {
          price_1m_blended_3_to_1: id === "old" ? 2.2 : 3.7,
          price_1m_input_tokens: id === "old" ? 0.8 : 1.1,
          price_1m_output_tokens: id === "old" ? 5.4 : 8.2,
        },
        median_output_tokens_per_second: id === "old" ? 54.5 : 92.6,
        median_time_to_first_token_seconds: id === "old" ? 0.91 : 0.48,
        median_time_to_first_answer_token: id === "old" ? 1.4 : 0.92,
      },
    ],
  };
}

describe("Artificial Analysis snapshot store", () => {
  test("a failed refresh serves the last-known-good snapshot, never deletes it, never returns unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:00:00.000Z"),
      });
      await store.write(snapshot("old"));

      const result = await store.refresh(() => {
        throw new Error("upstream unavailable");
      });

      expect(result.state).toBe("available");
      expect(result.source).toBe("last_known_good");
      expect(result.refreshError?.message).toBe("Artificial Analysis snapshot refresh failed");
      if (result.state !== "available") throw new Error("expected available snapshot");
      expect(result.snapshot.models[0]?.id).toBe("aa:model:old");
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed refresh sends the raw error only to the debug logger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const debugErrors: unknown[] = [];
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:00:00.000Z"),
        debugLogger: (error) => debugErrors.push(error),
      });

      const result = await store.refresh(() => {
        throw new Error("upstream unavailable with secret token");
      });

      expect(result.state).toBe("missing");
      expect(result.refreshError?.message).toBe("Artificial Analysis snapshot refresh failed");
      expect(result.refreshError?.message).not.toContain("secret token");
      expect(debugErrors).toHaveLength(1);
      expect(debugErrors[0]).toBeInstanceOf(Error);
      expect((debugErrors[0] as Error).message).toContain("secret token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a snapshot past TTL is returned marked stale with an age, not withheld", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 60,
        now: () => new Date("2026-08-24T10:02:30.000Z"),
      });
      await store.write(snapshot("old"), {
        fetchedAtIso: "2026-08-24T10:00:00.000Z",
        ttlSeconds: 60,
      });

      const result = await store.read();

      expect(result.state).toBe("available");
      expect(result.stale).toBe(true);
      expect(result.ageSeconds).toBe(150);
      if (result.state !== "available") throw new Error("expected available snapshot");
      expect(result.snapshot.models[0]?.id).toBe("aa:model:old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a concurrent reader never observes a torn/partial file during a refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:00:00.000Z"),
      });
      await store.write(snapshot("old"));

      const refresh = store.refresh(() => snapshot("new"));
      const reads = await Promise.all(
        Array.from({ length: 50 }, async () => {
          try {
            return JSON.parse(await readFile(path, "utf8")) as unknown;
          } catch (error) {
            return error;
          }
        }),
      );
      await refresh;

      for (const read of reads) {
        expect(read).not.toBeInstanceOf(Error);
        expect(read).toHaveProperty("models");
        expect(read).toHaveProperty("provenance");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent writes use distinct temp files and leave a valid JSON snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:00:00.000Z"),
      });

      const writes = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) => store.write(snapshot(String(index)))),
      );

      expect(writes.every((write) => write.status === "fulfilled")).toBe(true);
      const finalSnapshot: unknown = JSON.parse(await readFile(path, "utf8")) as unknown;
      expect(finalSnapshot).toHaveProperty("models");
      expect(finalSnapshot).toHaveProperty("provenance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the store persists across a fresh instance at the same path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const first = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:00:00.000Z"),
      });
      await first.write(snapshot("old"));

      const second = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:10:00.000Z"),
      });
      const result = await second.read();

      expect(result.state).toBe("available");
      if (result.state !== "available") throw new Error("expected available snapshot");
      expect(result.snapshot.models[0]?.id).toBe("aa:model:old");
      expect(result.ageSeconds).toBe(600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-time staleness follows the active store TTL when tightening and loosening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const first = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:10:00.000Z"),
      });
      await first.write(snapshot("old"), {
        fetchedAtIso: "2026-08-24T10:00:00.000Z",
        ttlSeconds: 3600,
      });

      const tightened = createAaSnapshotStore({
        path,
        ttlSeconds: 60,
        now: () => new Date("2026-08-24T10:10:00.000Z"),
      }).readSync();

      expect(tightened.state).toBe("available");
      expect(tightened.stale).toBe(true);

      await first.write(snapshot("old"), {
        fetchedAtIso: "2026-08-24T10:00:00.000Z",
        ttlSeconds: 60,
      });

      const loosened = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:10:00.000Z"),
      }).readSync();

      expect(loosened.state).toBe("available");
      expect(loosened.stale).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readSync reuses the parsed snapshot until mtime and size change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:10:00.000Z"),
      });
      await store.write(snapshot("old"), {
        fetchedAtIso: "2026-08-24T10:00:00.000Z",
        ttlSeconds: 3600,
      });

      const parseSpy = spyOn(JSON, "parse");
      try {
        const first = store.readSync();
        const second = store.readSync();
        expect(first.state).toBe("available");
        expect(second.state).toBe("available");
        expect(parseSpy).toHaveBeenCalledTimes(1);

        writeFileSync(
          path,
          `${JSON.stringify(
            {
              fetchedAtIso: "2026-08-24T10:05:00.000Z",
              ttlSeconds: 3600,
              provenance: {
                collectedAt: "2026-08-24T10:05:00.000Z",
                dataVersion: "changed-long-enough-to-change-file-size",
              },
              models: snapshot("new").models,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const third = store.readSync();
        expect(third.state).toBe("available");
        if (third.state !== "available") throw new Error("expected available snapshot");
        expect(third.snapshot.provenance.dataVersion).toBe(
          "changed-long-enough-to-change-file-size",
        );
        expect(parseSpy).toHaveBeenCalledTimes(2);
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("staleness is computed from an injected now(), not Date.now()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 60,
        now: () => new Date("2026-08-24T10:00:30.000Z"),
      });
      await store.write(snapshot("old"), {
        fetchedAtIso: "2026-08-24T10:00:00.000Z",
        ttlSeconds: 60,
      });

      const result = await store.read();

      expect(result.state).toBe("available");
      expect(result.ageSeconds).toBe(30);
      expect(result.stale).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readSync missing, corrupt, malformed, and oversized snapshots degrade without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const cases: {
        name: string;
        write?: (path: string) => void;
        state: "missing" | "corrupt";
      }[] = [
        { name: "missing", state: "missing" },
        {
          name: "corrupt-json",
          state: "corrupt",
          write: (path): void => {
            writeFileSync(path, '{"fetchedAtIso":', "utf8");
          },
        },
        {
          name: "malformed-timestamp",
          state: "corrupt",
          write: (path): void => {
            writeFileSync(
              path,
              `${JSON.stringify({
                fetchedAtIso: "garbage",
                ttlSeconds: 3600,
                provenance: { collectedAt: "2026-08-24T10:00:00.000Z" },
                models: snapshot("old").models,
              })}\n`,
              "utf8",
            );
          },
        },
        {
          name: "oversized",
          state: "corrupt",
          write: (path): void => {
            writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1));
          },
        },
      ];

      for (const entry of cases) {
        const path = join(dir, `${entry.name}.json`);
        entry.write?.(path);
        const store = createAaSnapshotStore({
          path,
          ttlSeconds: 3600,
          now: () => new Date("2026-08-24T10:00:00.000Z"),
        });
        const result = store.readSync();

        expect(result.state).toBe(entry.state);
        expect(result.stale).toBe(false);
        expect(result.ageSeconds).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt snapshot file is distinguished from a missing snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-store-"));
    try {
      const path = join(dir, "aa-snapshot.json");
      writeFileSync(path, '{"fetchedAtIso":', "utf8");
      const store = createAaSnapshotStore({
        path,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-24T10:00:00.000Z"),
      });

      const result = await store.read();

      expect(result.state).toBe("corrupt");
      expect(result.source).toBe("corrupt");
      expect(result.ageSeconds).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
