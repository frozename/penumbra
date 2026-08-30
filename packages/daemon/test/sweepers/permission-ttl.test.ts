import {
  type EmittedPermissionEvent,
  loadSqliteVec,
  migrate,
  PermissionEventBus,
  PermissionReader,
  PermissionWriter,
  type Services,
} from "@penumbra/core";
import { runPermissionTtlSweep } from "@src/sweepers/permission-ttl.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // Optional Homebrew SQLite is unavailable on non-local runners.
}

function noop(): undefined {
  return undefined;
}

function makeServices(db: Database, now: Date): Services {
  let n = 0;
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => "machine-test" },
    uuid: () => `evt-${String(++n)}`,
    clock: () => now,
    t0Writer: { write: noop },
    log: { info: noop, warn: noop },
  } as unknown as Services;
}

test("runPermissionTtlSweep transitions stale rows to expired and emits events", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date("2026-04-28T12:02:00.000Z"));

  const baseTs = new Date("2026-04-28T12:00:00.000Z");
  services.permissionWriter.create({
    permission_id: "p-stale",
    parent_handoff_id: "h-1",
    conversation_id: "c",
    agent_name: "a",
    tool_name: "t",
    raw_input: {},
    ttl_seconds: 60,
    now: baseTs,
  });
  services.permissionWriter.create({
    permission_id: "p-fresh",
    parent_handoff_id: "h-1",
    conversation_id: "c",
    agent_name: "a",
    tool_name: "t",
    raw_input: {},
    ttl_seconds: 600,
    now: baseTs,
  });
  const seen: EmittedPermissionEvent[] = [];
  services.permissionEvents.subscribe((event) => {
    seen.push(event);
  });

  const n = runPermissionTtlSweep(services);
  expect(n).toBe(1);
  expect(services.permissionReader.get("p-stale")?.status).toBe("expired");
  expect(services.permissionReader.get("p-fresh")?.status).toBe("pending");
  expect(seen.map((e) => e.kind)).toEqual(["permission.expired"]);
  expect(seen[0].permission_id).toBe("p-stale");
});

test("runPermissionTtlSweep is idempotent on subsequent calls", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date("2026-04-28T12:02:00.000Z"));

  services.permissionWriter.create({
    permission_id: "p-stale",
    parent_handoff_id: "h-1",
    conversation_id: "c",
    agent_name: "a",
    tool_name: "t",
    raw_input: {},
    ttl_seconds: 60,
    now: new Date("2026-04-28T12:00:00.000Z"),
  });
  expect(runPermissionTtlSweep(services)).toBe(1);
  expect(runPermissionTtlSweep(services)).toBe(0);
});

test("concurrent decide() does NOT cause the sweeper to double-emit for the decided row", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date("2026-04-28T12:02:00.000Z"));

  const baseTs = new Date("2026-04-28T12:00:00.000Z");
  // p-decided will be approved BEFORE the sweep runs
  services.permissionWriter.create({
    permission_id: "p-decided",
    parent_handoff_id: "h-1",
    conversation_id: "c",
    agent_name: "a",
    tool_name: "t",
    raw_input: {},
    ttl_seconds: 60,
    now: baseTs,
  });
  // p-stale is past TTL and never decided — sweeper should expire it
  services.permissionWriter.create({
    permission_id: "p-stale",
    parent_handoff_id: "h-1",
    conversation_id: "c",
    agent_name: "a",
    tool_name: "t",
    raw_input: {},
    ttl_seconds: 60,
    now: baseTs,
  });

  // Race window: sweeper snapshots BOTH candidates, but a concurrent decide
  // flips p-decided to approved BEFORE the sweep's UPDATE runs. The post-update
  // re-read filter must skip p-decided (status no longer 'expired') and only
  // emit for p-stale.
  services.permissionWriter.decide("p-decided", {
    decision: "approve",
    decided_by: "m",
    decided_at: "2026-04-28T12:01:00.000Z",
    reason: null,
  });

  const seen: string[] = [];
  services.permissionEvents.subscribe((e) => seen.push(e.permission_id));

  const n = runPermissionTtlSweep(services);
  expect(n).toBe(1); // only p-stale transitioned
  expect(seen).toEqual(["p-stale"]); // no permission.expired for p-decided
});
