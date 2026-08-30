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

import {
  permissionsCreateRoute,
  permissionsGetRoute,
  permissionsListRoute,
} from "@src/routes/permissions.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  /* already loaded */
}

interface PermissionRowView {
  permission_id: string;
  status: string;
}
interface PermissionGetBody {
  permission: PermissionRowView;
}
interface PermissionListBody {
  permissions: PermissionRowView[];
}

function makeServices(db: Database): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => "machine-test" },
    uuid: () => "evt-1",
    clock: () => new Date("2026-04-28T12:00:00.000Z"),
    t0Writer: { write: () => undefined },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => undefined, warn: () => undefined },
  } as unknown as Services;
}

async function seed(
  services: Services,
  permission_id: string,
  conversation_id = "c-1",
  parent_handoff_id = "h-1",
): Promise<void> {
  await permissionsCreateRoute(
    new Request("http://x/permissions", {
      method: "POST",
      body: JSON.stringify({
        permission_id,
        parent_handoff_id,
        conversation_id,
        agent_name: "a",
        tool_name: "t",
        raw_input: {},
        ttl_seconds: 300,
      }),
    }),
    services,
  );
}

test("GET /permissions/:id returns the row", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, "perm-1");
  const res = permissionsGetRoute(new Request("http://x/permissions/perm-1"), "perm-1", services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as PermissionGetBody;
  expect(body.permission.permission_id).toBe("perm-1");
  expect(body.permission.status).toBe("pending");
});

test("GET /permissions/:id returns 404 for unknown", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = permissionsGetRoute(new Request("http://x/permissions/nope"), "nope", services);
  expect(res.status).toBe(404);
});

test("GET /permissions filters by status (default pending)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, "perm-1");
  await seed(services, "perm-2");
  const res = permissionsListRoute(new Request("http://x/permissions"), services);
  const body = (await res.json()) as PermissionListBody;
  expect(body.permissions.map((p) => p.permission_id).sort()).toEqual(["perm-1", "perm-2"]);
});

test("GET /permissions filters by conversation_id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, "perm-A", "conv-A");
  await seed(services, "perm-B", "conv-B");
  const res = permissionsListRoute(
    new Request("http://x/permissions?conversation_id=conv-A"),
    services,
  );
  const body = (await res.json()) as PermissionListBody;
  expect(body.permissions.map((p) => p.permission_id)).toEqual(["perm-A"]);
});

test("GET /permissions filters by parent_handoff_id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, "perm-A", "c", "h-A");
  await seed(services, "perm-B", "c", "h-B");
  const res = permissionsListRoute(
    new Request("http://x/permissions?parent_handoff_id=h-A"),
    services,
  );
  const body = (await res.json()) as PermissionListBody;
  expect(body.permissions.map((p) => p.permission_id)).toEqual(["perm-A"]);
});

test("GET /permissions accepts comma-separated status list", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, "perm-1");
  // Force perm-1 to approved by going through writer directly.
  services.permissionWriter.decide("perm-1", {
    decision: "approve",
    decided_by: "m",
    decided_at: "2026-04-28T12:01:00.000Z",
    reason: null,
  });
  await seed(services, "perm-2");
  const res = permissionsListRoute(
    new Request("http://x/permissions?status=pending,approved"),
    services,
  );
  const body = (await res.json()) as PermissionListBody;
  expect(body.permissions.map((p) => p.permission_id).sort()).toEqual(["perm-1", "perm-2"]);
});

test("GET /permissions returns 400 for unknown status", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = permissionsListRoute(new Request("http://x/permissions?status=cancelled"), services);
  expect(res.status).toBe(400);
});
