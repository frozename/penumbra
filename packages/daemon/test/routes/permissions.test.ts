import {
  type EmittedPermissionEvent,
  loadSqliteVec,
  migrate,
  PermissionEventBus,
  PermissionReader,
  PermissionWriter,
  type Services,
} from "@penumbra/core";
import { permissionsCreateRoute, permissionsDecideRoute } from "@src/routes/permissions.js";
import { runPermissionTtlSweep } from "@src/sweepers/permission-ttl.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface MutableClockServices extends Services {
  clock: () => Date;
}

function makeServices(db: Database, now: Date): MutableClockServices {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => "machine-test" },
    uuid: () => "evt-1",
    clock: () => now,
    t0Writer: { write: () => undefined },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => undefined, warn: () => undefined },
  } as unknown as MutableClockServices;
}

async function createPending(services: Services, now: Date): Promise<void> {
  await permissionsCreateRoute(
    new Request("http://x/permissions", {
      method: "POST",
      body: JSON.stringify({
        permission_id: "p-1",
        parent_handoff_id: "h-1",
        conversation_id: "c-1",
        agent_name: "codex",
        tool_name: "terminal.create",
        raw_input: { cmd: "echo hi" },
        ttl_seconds: 300,
      }),
    }),
    services,
  );
  expect(services.permissionReader.get("p-1")?.created_at).toBe(now.toISOString());
}

test("permission.created payload includes routing fields", async () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now);
  const seen: EmittedPermissionEvent[] = [];
  services.permissionEvents.subscribe((event) => seen.push(event));

  await createPending(services, now);

  expect(seen).toHaveLength(1);
  expect(seen[0].kind).toBe("permission.created");
  expect(seen[0].payload).toMatchObject({
    permission_id: "p-1",
    parent_handoff_id: "h-1",
    conversation_id: "c-1",
    agent_name: "codex",
    tool_name: "terminal.create",
  });
});

test("permission.decided payload includes routing fields", async () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now);
  await createPending(services, now);
  const seen: EmittedPermissionEvent[] = [];
  services.permissionEvents.subscribe((event) => seen.push(event));

  await permissionsDecideRoute(
    new Request("http://x/permissions/p-1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }),
    "p-1",
    services,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0].kind).toBe("permission.decided");
  expect(seen[0].payload).toMatchObject({
    permission_id: "p-1",
    parent_handoff_id: "h-1",
    conversation_id: "c-1",
    agent_name: "codex",
    tool_name: "terminal.create",
  });
});

test("permission.expired payload includes routing fields", async () => {
  const createdAt = new Date("2026-04-28T12:00:00.000Z");
  const sweepAt = new Date("2026-04-28T12:06:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, createdAt);
  await createPending(services, createdAt);
  services.clock = (): Date => sweepAt;
  const seen: EmittedPermissionEvent[] = [];
  services.permissionEvents.subscribe((event) => seen.push(event));

  const transitioned = runPermissionTtlSweep(services);

  expect(transitioned).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0].kind).toBe("permission.expired");
  expect(seen[0].payload).toMatchObject({
    permission_id: "p-1",
    parent_handoff_id: "h-1",
    conversation_id: "c-1",
    agent_name: "codex",
    tool_name: "terminal.create",
  });
});
