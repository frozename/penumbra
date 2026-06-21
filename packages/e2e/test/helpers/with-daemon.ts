import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraClient } from "../../../agentchat/src/penumbra-client.js";
import { createDaemonFetchHandler } from "../../../daemon/test-utils.ts";

export function withDaemon(): {
  client: PenumbraClient;
  services: Services;
  stop: () => void;
} {
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-e2e-"));
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
    clock: (): Date => new Date("2026-04-26T00:00:00Z"),
    uuid: (): string => `id-${String(++n)}`,
  });
  services.agentRegistry = ["planner", "executor", "a", "b", "claude-mem"];
  services.watchdog.hasActiveWorker = (): boolean => true;

  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return await handler(req);
  };

  writeFileSync(join(storageRoot, "port"), "1\n");
  writeFileSync(join(storageRoot, "token"), `${token}\n`);

  return {
    client: new PenumbraClient({ storageRoot, fetch: fetchImpl }),
    services,
    stop(): void {
      try {
        services.supervisor.stopAll();
      } catch {
        /* best-effort stop */
      }
      db.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}
