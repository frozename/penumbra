import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, BundledEmbedder } from "@penumbra/core";
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
    embedder: new BundledEmbedder(),
  });
}

test("serve binds to 127.0.0.1 by default", () => {
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);
  const serveSpy = spyOn(Bun, "serve").mockImplementation(
    (opts: any) =>
      ({
        port: opts.port || 4444,
        stop: () => undefined,
      }) as any,
  );

  const handle = serve({ services, token: "test-token", port: 0 });

  expect(serveSpy).toHaveBeenCalled();
  expect(serveSpy.mock.calls[0]?.[0]).toMatchObject({ hostname: "127.0.0.1", port: 0 });
  handle.stop();
  expect(stop).toHaveBeenCalled();
  services.db.close();
});

test("serve honors PENUMBRA_DAEMON_HOST override", () => {
  process.env.PENUMBRA_DAEMON_HOST = "0.0.0.0";
  const services = makeServices();
  spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);
  const serveSpy = spyOn(Bun, "serve").mockImplementation(
    (opts: any) =>
      ({
        port: opts.port || 5555,
        stop: () => undefined,
      }) as any,
  );

  const handle = serve({ services, token: "test-token", port: 0 });

  expect(serveSpy.mock.calls[0]?.[0]).toMatchObject({ hostname: "0.0.0.0", port: 0 });
  handle.stop();
  services.db.close();
});
