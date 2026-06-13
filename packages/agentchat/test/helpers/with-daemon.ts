import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonFetchHandler } from "@penumbra/daemon/test-utils";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { PenumbraClient } from "../../src/penumbra-client.js";

export function withDaemon(): {
  client: PenumbraClient;
  services: Services;
  stop: () => void;
} {
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-agentchat-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: () => `id-${++n}`,
  });
  services.agentRegistry = ["planner", "executor", "a", "b", "claude-mem"];
  services.watchdog.hasActiveWorker = () => true;

  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  }) as typeof fetch;

  writeFileSync(join(storageRoot, "port"), "1\n");
  writeFileSync(join(storageRoot, "token"), `${token}\n`);

  return {
    client: new PenumbraClient({ storageRoot, fetch: fetchImpl }),
    services,
    stop() {
      try {
        services.supervisor.stopAll();
      } catch {}
      db.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}
