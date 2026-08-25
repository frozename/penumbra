import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { AaModelSchema, type AaModel } from "./schemas.js";

export const DEFAULT_AA_SNAPSHOT_PATH = "~/.penumbra/aa-snapshot.json";

export interface AaSnapshotStorePayload {
  provenance: {
    collectedAt: string;
    dataVersion?: string;
    benchmarkVersion?: string;
  };
  models: AaModel[];
}

export interface AaStoredSnapshot extends AaSnapshotStorePayload {
  fetchedAtIso: string;
  ttlSeconds: number;
}

export interface AaSnapshotStoreOptions {
  path?: string;
  ttlSeconds?: number;
  now?: () => Date;
  debugLogger?: (error: unknown) => void;
}

export type AaSnapshotStoreReadResult =
  | {
      state: "available";
      snapshot: AaStoredSnapshot;
      stale: boolean;
      ageSeconds: number;
      source: "store" | "refreshed" | "last_known_good";
      refreshError?: Error;
    }
  | {
      state: "missing";
      stale: false;
      ageSeconds: null;
      source: "missing";
      refreshError?: Error;
    }
  | {
      state: "corrupt";
      stale: false;
      ageSeconds: null;
      source: "corrupt";
      refreshError?: Error;
    };

export interface AaSnapshotStore {
  read(): Promise<AaSnapshotStoreReadResult>;
  readSync(): AaSnapshotStoreReadResult;
  write(
    payload: AaSnapshotStorePayload,
    metadata?: { fetchedAtIso?: string; ttlSeconds?: number },
  ): Promise<AaSnapshotStoreReadResult>;
  refresh(refresher: () => Promise<AaSnapshotStorePayload>): Promise<AaSnapshotStoreReadResult>;
}

const AaStoredSnapshotSchema = z.object({
  fetchedAtIso: z.string(),
  ttlSeconds: z.number().int().positive(),
  provenance: z.object({
    collectedAt: z.string(),
    dataVersion: z.string().optional(),
    benchmarkVersion: z.string().optional(),
  }),
  models: z.array(AaModelSchema),
});

let writeSeq = 0;

export function createAaSnapshotStore(opts: AaSnapshotStoreOptions = {}): AaSnapshotStore {
  const path = expandHome(opts.path ?? DEFAULT_AA_SNAPSHOT_PATH);
  const ttlSeconds = opts.ttlSeconds ?? 24 * 60 * 60;
  const now = opts.now ?? (() => new Date());
  const debugLogger = opts.debugLogger ?? (() => undefined);

  return {
    read(): Promise<AaSnapshotStoreReadResult> {
      return readSnapshot(path, now);
    },
    readSync(): AaSnapshotStoreReadResult {
      return readSnapshotSync(path, now);
    },
    async write(payload, metadata): Promise<AaSnapshotStoreReadResult> {
      const stored: AaStoredSnapshot = {
        fetchedAtIso: metadata?.fetchedAtIso ?? now().toISOString(),
        ttlSeconds: metadata?.ttlSeconds ?? ttlSeconds,
        provenance: payload.provenance,
        models: payload.models,
      };
      await writeSnapshot(path, stored);
      return resultFor(stored, now, "refreshed");
    },
    async refresh(refresher): Promise<AaSnapshotStoreReadResult> {
      try {
        const payload = await refresher();
        return await this.write(payload);
      } catch (error) {
        debugLogger(error);
        const lastKnownGood = await readSnapshot(path, now);
        if (lastKnownGood.state === "available") {
          return {
            ...lastKnownGood,
            source: "last_known_good",
            refreshError: normalizeError(error),
          };
        }
        return {
          state: "missing",
          stale: false,
          ageSeconds: null,
          source: "missing",
          refreshError: normalizeError(error),
        };
      }
    },
  };
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function readSnapshot(path: string, now: () => Date): Promise<AaSnapshotStoreReadResult> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = AaStoredSnapshotSchema.parse(JSON.parse(raw));
    return resultFor(parsed, now, "store");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        state: "missing",
        stale: false,
        ageSeconds: null,
        source: "missing",
      };
    }
    return {
      state: "corrupt",
      stale: false,
      ageSeconds: null,
      source: "corrupt",
    };
  }
}

function readSnapshotSync(path: string, now: () => Date): AaSnapshotStoreReadResult {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = AaStoredSnapshotSchema.parse(JSON.parse(raw));
    return resultFor(parsed, now, "store");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        state: "missing",
        stale: false,
        ageSeconds: null,
        source: "missing",
      };
    }
    return {
      state: "corrupt",
      stale: false,
      ageSeconds: null,
      source: "corrupt",
    };
  }
}

async function writeSnapshot(path: string, snapshot: AaStoredSnapshot): Promise<void> {
  const parsed = AaStoredSnapshotSchema.parse(snapshot);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${String(process.pid)}.${String(++writeSeq)}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/**
 * External benchmark data is age-discounted by the router, so an expired AA
 * snapshot remains available and is explicitly marked stale with its age.
 */
function resultFor(
  snapshot: AaStoredSnapshot,
  now: () => Date,
  source: "store" | "refreshed" | "last_known_good",
): AaSnapshotStoreReadResult {
  const fetchedAtMs = new Date(snapshot.fetchedAtIso).getTime();
  const ageSeconds = Number.isFinite(fetchedAtMs)
    ? Math.max(0, Math.floor((now().getTime() - fetchedAtMs) / 1000))
    : Infinity;
  return {
    state: "available",
    snapshot,
    stale: ageSeconds === Infinity || ageSeconds > snapshot.ttlSeconds,
    ageSeconds,
    source,
  };
}

function normalizeError(error: unknown): Error {
  return new Error("Artificial Analysis snapshot refresh failed");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
