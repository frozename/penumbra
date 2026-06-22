import { buildServices, BundledEmbedder, loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect } from "bun:test";

import { serve } from "../src/serve.js";
import { serviceTest } from "./helpers/service-gates.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

serviceTest("onStop callback is invoked exactly once when handle.stop() is called", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp",
    db,
    embedder: new BundledEmbedder(),
  });

  let callCount = 0;
  const handle = serve({
    services,
    token: "test-token",
    port: 0,
    onStop: () => {
      callCount += 1;
    },
  });

  expect(callCount).toBe(0);
  await handle.stop();
  expect(callCount).toBe(1);
});

serviceTest("onStop callback swallows throws and does not propagate", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp",
    db,
    embedder: new BundledEmbedder(),
  });

  const handle = serve({
    services,
    token: "test-token",
    port: 0,
    onStop: () => {
      throw new Error("db already closed");
    },
  });

  // Must not throw — onStop errors are swallowed.
  expect(() => handle.stop()).not.toThrow();
});
