import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DaemonHandle, serve } from "../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

export interface TempDaemon {
  services: Services;
  handle: DaemonHandle;
  url: string;
  token: string;
  dir: string;
  stop(): void;
}

export function makeTempDaemon(opts: { token?: string } = {}): TempDaemon {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-daemon-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-23T12:00:00Z"),
    uuid: ((): (() => string) => {
      let n = 0;
      return (): string => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
    })(),
  });
  const token = opts.token ?? "test-token";
  const handle = serve({ services, token, port: 0 });
  return {
    services,
    handle,
    token,
    url: `http://localhost:${String(handle.port)}`,
    dir,
    stop(): void {
      services.supervisor.stopAll();
      void handle.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
