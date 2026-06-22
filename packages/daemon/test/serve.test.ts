import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { serve } from "../src/serve.js";
import { serviceTest } from "./helpers/service-gates.js";

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

function makeServices(): Services {
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
    const res = await fetch(`http://127.0.0.1:${String(handle.port)}/health`);
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
    const res = await fetch(`http://127.0.0.1:${String(handle.port)}/health`);
    expect(res.status).toBe(200);
  } finally {
    await handle.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});

serviceTest("serve installs global crash handlers once", async () => {
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const baselineUnhandled = process.listenerCount("unhandledRejection");
  const baselineUncaught = process.listenerCount("uncaughtException");

  const handle1 = serve({ services, token: "test-token", port: 0 });
  const afterFirstUnhandled = process.listenerCount("unhandledRejection");
  const afterFirstUncaught = process.listenerCount("uncaughtException");
  const handle2 = serve({ services, token: "test-token", port: 0 });

  try {
    expect(afterFirstUnhandled).toBeGreaterThanOrEqual(baselineUnhandled + 1);
    expect(afterFirstUncaught).toBeGreaterThanOrEqual(baselineUncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(afterFirstUnhandled);
    expect(process.listenerCount("uncaughtException")).toBe(afterFirstUncaught);
  } finally {
    await handle1.stop();
    await handle2.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});

test("serve leaves process signal handling to direct embedders by default", async () => {
  const services = makeServices();
  spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const baselineSigterm = process.listenerCount("SIGTERM");
  const baselineSigint = process.listenerCount("SIGINT");
  const handle = serve({ services, token: "test-token", port: 0 });

  try {
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
  } finally {
    await handle.stop();
    services.db.close();
  }
});
