import { afterEach, expect, mock, spyOn } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { serve } from "../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

afterEach(() => {
  delete process.env.PENUMBRA_DAEMON_HOST;
  mock.restore();
});

function makeServices() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
}

serviceTest("serve binds to 127.0.0.1 by default", async () => {
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const handle = serve({ services, token: "test-token", port: 0 });
  try {
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
  } finally {
    await handle.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});

serviceTest("serve honors PENUMBRA_DAEMON_HOST override", async () => {
  process.env.PENUMBRA_DAEMON_HOST = "0.0.0.0";
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const handle = serve({ services, token: "test-token", port: 0 });
  try {
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
  } finally {
    await handle.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});
