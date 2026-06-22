import {
  loadSqliteVec,
  migrate,
  PermissionEventBus,
  PermissionReader,
  PermissionWriter,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { permissionsCreateRoute } from "../../src/routes/permissions.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* loaded */
}

function makeServices(db: Database): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => "machine-test" },
    uuid: () => "uuid-not-used", // route uses client-supplied permission_id
    clock: () => new Date("2026-04-28T12:00:00.000Z"),
    t0Writer: { write: () => undefined },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => undefined, warn: () => undefined },
  } as unknown as Services;
}

test("POST /permissions creates a pending row", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request("http://x/permissions", {
    method: "POST",
    body: JSON.stringify({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "conv-1",
      agent_name: "claude-acp-sonnet",
      tool_name: "fs.readTextFile",
      raw_input: { path: "src/foo.ts" },
      ttl_seconds: 300,
    }),
  });
  const res = await permissionsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.permission_id).toBe("perm-1");
  expect(body.status).toBe("pending");
  expect(body.ttl_at).toBe("2026-04-28T12:05:00.000Z");
});

test("POST /permissions emits permission.created on the event bus", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const seen: string[] = [];
  services.permissionEvents.subscribe((evt) => seen.push(evt.kind));

  const req = new Request("http://x/permissions", {
    method: "POST",
    body: JSON.stringify({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    }),
  });
  await permissionsCreateRoute(req, services);
  expect(seen).toEqual(["permission.created"]);
});

test("POST /permissions is idempotent on permission_id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const seen: string[] = [];
  services.permissionEvents.subscribe((evt) => seen.push(evt.kind));

  const body = JSON.stringify({
    permission_id: "perm-1",
    parent_handoff_id: "h-1",
    conversation_id: "c",
    agent_name: "a",
    tool_name: "t",
    raw_input: {},
    ttl_seconds: 300,
  });
  const r1 = await permissionsCreateRoute(
    new Request("http://x/permissions", { method: "POST", body }),
    services,
  );
  const r2 = await permissionsCreateRoute(
    new Request("http://x/permissions", { method: "POST", body }),
    services,
  );
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  expect((await r2.json()).status).toBe("pending");
  expect(seen).toEqual(["permission.created"]);
});

test("POST /permissions returns 400 for invalid body", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const req = new Request("http://x/permissions", { method: "POST", body: JSON.stringify({}) });
  const res = await permissionsCreateRoute(req, services);
  expect(res.status).toBe(400);
});

test("POST /permissions defaults ttl_seconds from settings", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request("http://x/permissions", {
    method: "POST",
    body: JSON.stringify({
      permission_id: "perm-1",
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
    }),
  });
  const res = await permissionsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  // 12:00:00 + 300s = 12:05:00
  expect(body.ttl_at).toBe("2026-04-28T12:05:00.000Z");
});
