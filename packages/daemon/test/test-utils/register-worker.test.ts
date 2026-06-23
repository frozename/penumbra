import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest, serve } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { createHash } from "node:crypto";

import { serviceTest } from "../helpers/service-gates.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "shared-sec";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/daemon-register-worker-test-utils",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `e-${String(++n)}`;
    })(),
  });
}

async function withDaemon<T>(
  fn: (args: { baseUrl: string; services: Services }) => Promise<T>,
): Promise<T> {
  const services = tempServices();
  const handle = serve({ services, token: SHARED_TOKEN, port: 0 });
  const baseUrl = `http://127.0.0.1:${String(handle.port)}`;
  try {
    return await fn({ baseUrl, services });
  } finally {
    await handle.stop();
    services.db.close();
  }
}

serviceTest(
  "registerWorkerForTest posts /worker/register with shared bearer and returns worker_token",
  async () => {
    await withDaemon(async ({ baseUrl, services }) => {
      const result = await registerWorkerForTest({
        baseUrl,
        sharedBearer: SHARED_TOKEN,
        worker_id: "W-A",
        metadata: { host: "x" },
      });

      expect(result.worker_id).toBe("W-A");
      expect(typeof result.worker_token).toBe("string");
      // base64url of 32 random bytes = 43 chars (no padding)
      expect(result.worker_token.length).toBe(43);

      const hash = createHash("sha256").update(result.worker_token).digest("hex");
      const row = services.db
        .query<
          { worker_id: string; metadata_json: string | null },
          [string]
        >("SELECT worker_id, metadata_json FROM worker_tokens WHERE token_hash = ?")
        .get(hash);
      expect(row).toBeDefined();
      expect(row.worker_id).toBe("W-A");
      expect(row.metadata_json).toBe(JSON.stringify({ host: "x" }));
    });
  },
);

serviceTest("registerWorkerForTest without metadata persists metadata_json NULL", async () => {
  await withDaemon(async ({ baseUrl, services }) => {
    const result = await registerWorkerForTest({
      baseUrl,
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-B",
    });

    const hash = createHash("sha256").update(result.worker_token).digest("hex");
    const row = services.db
      .query<
        { metadata_json: string | null },
        [string]
      >("SELECT metadata_json FROM worker_tokens WHERE token_hash = ?")
      .get(hash);
    expect(row).toBeDefined();
    expect(row.metadata_json).toBe(null);
  });
});

serviceTest("returned worker_token authenticates a subsequent /worker/heartbeat call", async () => {
  await withDaemon(async ({ baseUrl }) => {
    const { worker_token } = await registerWorkerForTest({
      baseUrl,
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
    });

    const res = await fetch(`${baseUrl}/worker/heartbeat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${worker_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A" }),
    });
    expect(res.status).toBe(200);
  });
});

serviceTest("registerWorkerForTest throws on non-200 (e.g., wrong shared bearer)", async () => {
  await withDaemon(async ({ baseUrl }) => {
    let thrown: unknown;
    try {
      await registerWorkerForTest({
        baseUrl,
        sharedBearer: "wrong-sec",
        worker_id: "W-A",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected Error");
    expect(thrown.message).toContain("registerWorkerForTest: HTTP 401");
  });
});
