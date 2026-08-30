import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@penumbra/daemon/test-utils";
import { PenumbraClient } from "@src/penumbra-client.js";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    uuid: () => `id-${String(++n)}`,
  });
  services.agentRegistry = ["planner", "executor", "a", "b", "claude-mem"];
  services.watchdog.hasActiveWorker = (): boolean => true;

  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return await handler(req);
  }) as typeof fetch;

  writeFileSync(join(storageRoot, "port"), "1\n");
  writeFileSync(join(storageRoot, "token"), `${token}\n`);

  return {
    client: new PenumbraClient({ storageRoot, fetch: fetchImpl }),
    services,
    stop(): void {
      try {
        services.supervisor.stopAll();
      } catch {
        // best-effort: shutdown errors during test teardown are non-fatal
      }
      db.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}
