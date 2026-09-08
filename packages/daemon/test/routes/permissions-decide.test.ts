import { PermissionDecideResponseSchema } from "@penumbra/api-contract";
import {
  type EmittedPermissionEvent,
  loadSqliteVec,
  migrate,
  PermissionEventBus,
  PermissionReader,
  PermissionWriter,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { permissionsCreateRoute, permissionsDecideRoute } from "@src/routes/permissions.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  /* already loaded */
}

interface DecideBody {
  status: string;
}
interface ConflictBody {
  current_status: string;
}

function makeServices(db: Database): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => "machine-test" },
    uuid: () => "evt-1",
    clock: () => new Date("2026-04-28T12:01:00.000Z"),
    t0Writer: { write: () => undefined },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => undefined, warn: () => undefined },
  } as unknown as Services;
}

async function seedPending(services: Services, id = "perm-1"): Promise<void> {
  await permissionsCreateRoute(
    new Request("http://x/permissions", {
      method: "POST",
      body: JSON.stringify({
        permission_id: id,
        parent_handoff_id: "h-1",
        conversation_id: "c-1",
        agent_name: "a",
        tool_name: "t",
        raw_input: { path: "src/foo.ts" },
        ttl_seconds: 300,
      }),
    }),
    services,
  );
}

test("POST /permissions/:id/decide approves a pending row", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);

  const res = await permissionsDecideRoute(
    new Request("http://x/permissions/perm-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", remember: "this_dispatch" }),
    }),
    "perm-1",
    services,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as DecideBody;
  expect(body.status).toBe("approved");
  expect(services.permissionReader.get("perm-1")?.remember_scope).toBe("this_dispatch");
});

test("POST /permissions/:id/decide emits permission.decided", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  const seen: EmittedPermissionEvent[] = [];
  services.permissionEvents.subscribe((e) => seen.push(e));

  await permissionsDecideRoute(
    new Request("http://x/permissions/perm-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "reject", reason: "no third-party calls" }),
    }),
    "perm-1",
    services,
  );
  expect(seen.map((e) => e.kind)).toEqual(["permission.decided"]);
  expect(seen[0].payload.decision).toBe("reject");
  expect(seen[0].payload.reason).toBe("no third-party calls");
});

test("POST /permissions/:id/decide returns 409 if already terminal", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  // First decision succeeds.
  await permissionsDecideRoute(
    new Request("http://x/permissions/perm-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }),
    "perm-1",
    services,
  );
  // Second decision conflicts.
  const res = await permissionsDecideRoute(
    new Request("http://x/permissions/perm-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "reject" }),
    }),
    "perm-1",
    services,
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as ConflictBody;
  expect(body.current_status).toBe("approved");
});

test("POST /permissions/:id/decide returns 404 for unknown id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await permissionsDecideRoute(
    new Request("http://x/permissions/nope/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }),
    "nope",
    services,
  );
  expect(res.status).toBe(404);
});

test("POST /permissions/:id/decide returns 400 for invalid body", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  const res = await permissionsDecideRoute(
    new Request("http://x/permissions/perm-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "maybe" }),
    }),
    "perm-1",
    services,
  );
  expect(res.status).toBe(400);
});

test("POST /permissions/:id/decide body parses with PermissionDecideResponseSchema", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  const res = await permissionsDecideRoute(
    new Request("http://x/permissions/perm-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }),
    "perm-1",
    services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(PermissionDecideResponseSchema.safeParse(body).success).toBe(true);
});
