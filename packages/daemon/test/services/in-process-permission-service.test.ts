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

import { permissionsDecideRoute, permissionsListRoute } from "@src/routes/permissions.js";
import { InProcessPermissionService } from "@src/services/in-process-permission-service.js";
import { runPermissionTtlSweep } from "@src/sweepers/permission-ttl.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // setCustomSQLite throws after SQLite has already loaded in the process.
}

async function expectRejectsWith(promise: Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(expected);
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

function noop(): void {
  return undefined;
}

function makeServices(
  db: Database,
  now: Date,
  opts?: { handoff?: { handoff_id: string; conversation_id: string } },
): Services {
  let nUuid = 0;
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => "machine-test" },
    uuid: () => `id-${String(++nUuid)}`,
    clock: () => now,
    t0Writer: { write: noop },
    settings: { permission_ttl_seconds: 300 },
    log: { info: noop, warn: noop },
    handoffReader: {
      get: (id: string) =>
        opts?.handoff?.handoff_id === id
          ? { handoff_id: id, conversation_id: opts.handoff.conversation_id, status: "pending" }
          : null,
    },
  } as unknown as Services;
}

test("requestPermission resolves on permission.decided=approve", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: { session_id: "s-1", initial_command: "ls" },
  });

  // Find the just-created permission_id (uuid factory gives 'id-1' first).
  const permission_id = "id-1";
  await permissionsDecideRoute(
    new Request("http://x/permissions/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", resolved_by: "user" }),
    }),
    permission_id,
    services,
  );

  const result = await decision;
  expect(result.approved).toBe(true);
  svc.stop();
});

test("requestPermission resolves on permission.decided=reject with reason", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run.dangerous",
    context: { command: "rm -rf /" },
  });

  await permissionsDecideRoute(
    new Request("http://x/permissions/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "reject", reason: "too dangerous", resolved_by: "user" }),
    }),
    "id-1",
    services,
  );

  const result = await decision;
  expect(result.approved).toBe(false);
  expect(result.reason).toBe("too dangerous");
  svc.stop();
});

test("requestPermission rejects when ttl sweep marks expired", async () => {
  const t0 = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, t0, { handoff: { handoff_id: "h-1", conversation_id: "c-1" } });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: {},
    ttl_seconds: 1,
  });

  // Advance the clock past TTL and run the sweeper.
  services.clock = (): Date => new Date("2026-05-03T12:00:10.000Z");
  runPermissionTtlSweep(services);

  await expectRejectsWith(decision, /expired/);
  svc.stop();
});

test("requestPermission falls back to handoff_id as conversation_id when handoff is unknown", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now /* no handoff override */);
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-orphan",
    agent_name: "codex-acp-zed",
    tool_name: "shell_run",
    context: {},
  });

  const row = services.permissionReader.get("id-1");
  expect(row?.conversation_id).toBe("h-orphan");

  await permissionsDecideRoute(
    new Request("http://x/permissions/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", resolved_by: "user" }),
    }),
    "id-1",
    services,
  );
  expect((await decision).approved).toBe(true);
  svc.stop();
});

test("stop() rejects pending waiters", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: {},
  });

  svc.stop();
  await expectRejectsWith(decision, /stopped/);
});

test("aborting a request rejects its waiter and durably removes it from the pending queue", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const auditEvents: { event_type: string; payload_json: unknown }[] = [];
  services.t0Writer.write = (event): void => {
    auditEvents.push({ event_type: event.event_type, payload_json: event.payload_json });
  };
  const svc = new InProcessPermissionService(services);
  Object.assign(services, { permissionService: svc });
  svc.start();
  const controller = new AbortController();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: {},
    signal: controller.signal,
  });
  const abortedDecision = expectRejectsWith(decision, /aborted/);
  controller.abort();

  const lateApproval = await permissionsDecideRoute(
    new Request("http://x/permissions/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", resolved_by: "user" }),
    }),
    "id-1",
    services,
  );
  expect(lateApproval.status).toBe(409);

  await Promise.race([
    abortedDecision,
    Bun.sleep(100).then(() => {
      throw new Error("aborted permission waiter did not settle");
    }),
  ]);
  await Bun.sleep(10);
  expect(services.permissionReader.get("id-1")?.status).toBe("rejected");
  expect(
    services.permissionReader.listByStatus({
      statuses: ["pending"],
      parent_handoff_id: "h-1",
    }),
  ).toHaveLength(0);
  expect(auditEvents.at(-1)).toMatchObject({
    event_type: "permission-decided",
    payload_json: { decided_by: "request_abort" },
  });

  const freshDecision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: {},
  });
  const freshPermission = services.permissionReader.listByStatus({
    statuses: ["pending"],
    parent_handoff_id: "h-1",
  })[0];
  expect(freshPermission).toBeDefined();
  await permissionsDecideRoute(
    new Request("http://x/permissions/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", resolved_by: "user" }),
    }),
    freshPermission!.permission_id,
    services,
  );
  expect((await freshDecision).approved).toBe(true);
  svc.stop();
});

test("aborting a request settles its waiter when durable cleanup throws", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const warnings: string[] = [];
  services.log.warn = (fields: unknown): void => {
    warnings.push(JSON.stringify(fields));
  };
  services.permissionWriter.decide = (): never => {
    throw new Error("database busy");
  };
  const svc = new InProcessPermissionService(services);
  Object.assign(services, { permissionService: svc });
  svc.start();
  const controller = new AbortController();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: {},
    signal: controller.signal,
  });
  controller.abort();

  await Promise.race([
    expectRejectsWith(decision, /aborted/),
    Bun.sleep(100).then(() => {
      throw new Error("aborted permission waiter did not settle");
    }),
  ]);
  await Bun.sleep(10);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("database busy");
  expect(svc.isPermissionAborted("id-1")).toBe(true);
  const pending = (await permissionsListRoute(
    new Request("http://x/permissions?status=pending&parent_handoff_id=h-1"),
    services,
  ).json()) as { permissions: unknown[] };
  expect(pending.permissions).toHaveLength(0);
  const lateApproval = await permissionsDecideRoute(
    new Request("http://x/permissions/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", resolved_by: "user" }),
    }),
    "id-1",
    services,
  );
  expect(lateApproval.status).toBe(409);

  services.clock = (): Date => new Date("2026-05-03T12:05:01.000Z");
  expect(runPermissionTtlSweep(services)).toBe(1);
  expect(services.permissionReader.get("id-1")?.status).toBe("expired");
  expect(svc.isPermissionAborted("id-1")).toBe(false);
  svc.stop();
});

test("aborting a request releases suppression when durable cleanup returns no row", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const durableDecide = services.permissionWriter.decide.bind(services.permissionWriter);
  services.permissionWriter.decide = (permissionId, input): null => {
    durableDecide(permissionId, input);
    return null;
  };
  const svc = new InProcessPermissionService(services);
  Object.assign(services, { permissionService: svc });
  svc.start();
  const controller = new AbortController();

  const decision = svc.requestPermission({
    parent_handoff_id: "h-1",
    agent_name: "claude-acp-sonnet",
    tool_name: "shell_run",
    context: {},
    signal: controller.signal,
  });
  controller.abort();

  await expectRejectsWith(decision, /aborted/);
  await Bun.sleep(10);
  expect(services.permissionReader.get("id-1")?.status).toBe("rejected");
  expect(svc.isPermissionAborted("id-1")).toBe(false);
  svc.stop();
});

test("throws if started twice or used before start", async () => {
  const now = new Date("2026-05-03T12:00:00.000Z");
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, {
    handoff: { handoff_id: "h-1", conversation_id: "c-1" },
  });
  const svc = new InProcessPermissionService(services);

  await expectRejectsWith(
    svc.requestPermission({
      parent_handoff_id: "h-1",
      agent_name: "codex-acp-zed",
      tool_name: "shell_run",
      context: {},
    }),
    /not started/,
  );

  svc.start();
  svc.start(); // idempotent
  svc.stop();
});
