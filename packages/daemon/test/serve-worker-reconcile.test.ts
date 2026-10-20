import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // SQLite may already be loaded by another test file.
}

const BOOT = "2026-10-07T12:00:00.000Z";

function seedDispatch(services: Services, id: string, claimedAt: string): void {
  services.handoffWriter.create({
    handoff_id: id,
    ts: claimedAt,
    from: "a",
    to: "b",
    message: "recover previous incarnation",
    conversation_id: id,
    max_dispatch_attempts: 3,
  });
  services.handoffWriter.approve(id, { resolved_by: "test", resolved_at: claimedAt });
  expect(services.handoffWriter.claimDispatch(id, "w1")).toBe(true);
  services.db
    .query("UPDATE handoffs SET last_dispatch_started_at=? WHERE handoff_id=?")
    .run(claimedAt, id);
  services.dispatchEventLog.record({
    handoff_id: id,
    worker_id: "w1",
    source: "worker",
    kind: "dispatch.start",
    ts: claimedAt,
  });
}

test("serve exposes bounded worker orphan recovery after startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "serve-worker-reconcile-"));
  const envKeys = [
    "PENUMBRA_EXTRA_WORKERS_ENABLED",
    "PENUMBRA_CONFIG_DIR",
    "PENUMBRA_WORKERS_CONFIG_PATH",
  ] as const;
  const previous = envKeys.map((key) => process.env[key]);
  process.env[envKeys[0]] = "0";
  process.env[envKeys[1]] = root;
  process.env[envKeys[2]] = join(root, "workers.yaml");
  writeFileSync(process.env[envKeys[2]], "extras: []\n");
  const db = new Database(":memory:");
  let handle: ReturnType<typeof serve> | undefined;
  let start: { mockRestore(): void } | undefined;
  let stop: { mockRestore(): void } | undefined;
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const services = buildServices({
      env: {},
      input: {},
      storageRoot: root,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => new Date(BOOT),
    });
    start = spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);
    stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
    seedDispatch(services, "before", "2026-10-07T11:59:00.000Z");
    seedDispatch(services, "at", BOOT);
    seedDispatch(services, "after", "2026-10-07T12:01:00.000Z");
    handle = serve({ services, token: "test-token", port: 0, hostname: "127.0.0.1" });
    const baseUrl = `http://127.0.0.1:${String(handle.port)}`;
    const { worker_token } = await registerWorkerForTest({
      baseUrl,
      sharedBearer: "test-token",
      worker_id: "w1",
    });
    const response = await fetch(`${baseUrl}/worker/reconcile-orphans`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}`, "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "w1", claimed_before: BOOT }),
    });
    const body: unknown = await response.json();
    expect({ status: response.status, body }).toEqual({
      status: 200,
      body: { requeued: 1, exhausted: 0, requeuedRowIds: ["before"], exhaustedRowIds: [] },
    });
    expect(services.handoffReader.get("before")).toMatchObject({
      status: "approved",
      worker_id: null,
    });
    for (const id of ["at", "after"]) {
      expect(services.handoffReader.get(id)).toMatchObject({
        status: "dispatched",
        worker_id: "w1",
      });
      expect(services.dispatchEventLog.listByHandoff(id).map((event) => event.kind)).toEqual([
        "dispatch.start",
      ]);
    }
    expect(services.dispatchEventLog.listByHandoff("before").map((event) => event.kind)).toContain(
      "worker.recovery.requeued",
    );
  } finally {
    await handle?.stop();
    start?.mockRestore();
    stop?.mockRestore();
    db.close();
    for (const [index, key] of envKeys.entries()) {
      const value = previous[index];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
