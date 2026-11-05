import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* ignored: best-effort darwin sqlite hint */
}

const noop = (): void => undefined;

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "registrar-error-route-"));
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: root }]]),
  );
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-08-26T12:00:00.000Z"),
    worktreeRootDir,
    mainRepoDir,
    projectRegistry,
  });
  services.watchdog = {
    recordHeartbeat: noop,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  Object.assign(services, {
    agentchatConfig: {
      agents: [{ name: "codex-acp-fast", tags: ["typescript"], tier: "cli" }],
    },
  });

  const taskEvents = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    now: (): number => services.clock().getTime(),
    bus: taskEvents,
  });
  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token, taskEvents, taskWriter });

  return {
    fetch: (path: string, init?: RequestInit): Promise<Response> =>
      handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        /* ignored: best-effort teardown */
      }
      try {
        db.close();
      } catch {
        /* ignored: best-effort teardown */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function registrarCreateInput(): Record<string, unknown> {
  return {
    title: "Registrar rollout",
    slug: "registrar-rollout",
    home_project: "penumbra",
    phases: ["Domain", "HTTP routes"],
  };
}

function authJsonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createRegistrar(
  daemon: ReturnType<typeof startTestDaemon>,
  slug?: string,
): Promise<string> {
  const response = await daemon.fetch("/registrar", {
    method: "POST",
    headers: authJsonHeaders(daemon.token),
    body: JSON.stringify(slug ? { ...registrarCreateInput(), slug } : registrarCreateInput()),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { registrar_id: string }).registrar_id;
}

async function appendEvent(
  daemon: ReturnType<typeof startTestDaemon>,
  registrarId: string,
  event: Record<string, unknown>,
): Promise<Response> {
  return await daemon.fetch(`/registrar/${registrarId}/events`, {
    method: "POST",
    headers: authJsonHeaders(daemon.token),
    body: JSON.stringify(event),
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("POST /registrar twice with the same slug: second returns 409 registrar_slug_taken, one entry stored", async () => {
  // Mutation: drop the RegistrarSlugTaken branch in registrarCreateRoute — the error rethrows uncaught and the request rejects or throws instead of returning 409.
  const daemon = startTestDaemon();
  try {
    const first = await daemon.fetch("/registrar", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify(registrarCreateInput()),
    });
    expect(first.status).toBe(201);

    const second = await daemon.fetch("/registrar", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify(registrarCreateInput()),
    });
    expect(second.status).toBe(409);
    expect(await jsonOf(second)).toEqual({
      error: "registrar_slug_taken",
      slug: "registrar-rollout",
    });
    expect(daemon.services.registrarReader.listEntries()).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events with unknown phase_no returns 404 phase_not_found and appends nothing", async () => {
  // Mutation: change the PhaseNotFound status in registrarAppendRoute to 400.
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await appendEvent(daemon, registrarId, {
      kind: "progress",
      phase_no: 9,
      actor: "maestro",
      body: "x",
    });

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({
      error: "phase_not_found",
      registrar_id: registrarId,
      phase_no: 9,
    });
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("phase_transition for a missing phase returns 404 phase_not_found, not 409 invalid_phase_transition", async () => {
  // Mutation: move the validatePhaseReference call after the phase UPDATE in the core writer — the stale from_status is seen first and yields 409 invalid_phase_transition.
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await appendEvent(daemon, registrarId, {
      kind: "phase_transition",
      phase_no: 9,
      from_status: "active",
      state: "complete",
      actor: "maestro",
      body: "x",
    });

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({
      error: "phase_not_found",
      registrar_id: registrarId,
      phase_no: 9,
    });
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("replaying a phase_transition with a stale from_status returns 409 invalid_phase_transition with the full body", async () => {
  // Mutation: drop phase_no from the InvalidPhaseTransition 409 body in registrarAppendRoute.
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);
    const transition = {
      kind: "phase_transition",
      phase_no: 1,
      from_status: "active",
      state: "complete",
      actor: "maestro",
      body: "x",
    };

    const first = await appendEvent(daemon, registrarId, transition);
    expect(first.status).toBe(200);

    const second = await appendEvent(daemon, registrarId, transition);
    expect(second.status).toBe(409);
    expect(await jsonOf(second)).toEqual({
      error: "invalid_phase_transition",
      registrar_id: registrarId,
      phase_no: 1,
      from_status: "active",
    });
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test("blocker resolved with an unknown ref_event_id returns 400 unknown_journal_ref and appends nothing", async () => {
  // Mutation: change the UnknownJournalRef status in registrarAppendRoute to 404.
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await appendEvent(daemon, registrarId, {
      kind: "blocker",
      state: "resolved",
      ref_event_id: 999,
      actor: "maestro",
      body: "x",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({
      error: "unknown_journal_ref",
      registrar_id: registrarId,
      ref_event_id: 999,
    });
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("blocker resolved on registrar B referencing an event from registrar A returns 400 unknown_journal_ref", async () => {
  // Mutation: in validateEventReference in packages/core/src/registrar/writer.ts, drop both the "AND registrar_id = ?" clause and the registrar_id bind argument (.get(ref_event_id)) — the cross-registrar ref then resolves and the append returns 200.
  const daemon = startTestDaemon();
  try {
    const registrarA = await createRegistrar(daemon);
    const registrarB = await createRegistrar(daemon, "registrar-rollout-b");

    const opened = await appendEvent(daemon, registrarA, {
      kind: "blocker",
      state: "opened",
      actor: "maestro",
      body: "blocked on A",
    });
    expect(opened.status).toBe(200);
    const { event } = (await opened.json()) as { event: { event_id: number } };

    const resolve = await appendEvent(daemon, registrarB, {
      kind: "blocker",
      state: "resolved",
      ref_event_id: event.event_id,
      actor: "maestro",
      body: "cross-registrar resolve",
    });

    expect(resolve.status).toBe(400);
    expect(await jsonOf(resolve)).toEqual({
      error: "unknown_journal_ref",
      registrar_id: registrarB,
      ref_event_id: event.event_id,
    });
    expect(daemon.services.registrarReader.listEvents(registrarB)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar with a malformed JSON body returns 400 invalid_input and stores nothing", async () => {
  // Mutation: change the safeJson-null branch status in registrarCreateRoute from 400 to 422.
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({
      error: "invalid_input",
      details: [{ message: "request body was not valid JSON" }],
    });
    expect(daemon.services.registrarReader.listEntries()).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events with a malformed JSON body returns 400 invalid_input and appends nothing", async () => {
  // Mutation: change the safeJson-null branch status in registrarAppendRoute from 400 to 422.
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({
      error: "invalid_input",
      details: [{ message: "request body was not valid JSON" }],
    });
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar with an unrecognized key returns 400 invalid_input with an unrecognized_keys issue", async () => {
  // Mutation: remove .strict() from BOTH the route's RegistrarCreateRequestSchema.strict() call in registrarCreateRoute AND the trailing .strict() on RegistrarCreateRequestSchema in packages/api-contract/src/registrar.ts — Zod then strips the extra key and the create returns 201; removing only the route's call is redundant and would not fail the test.
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ ...registrarCreateInput(), owner: "someone" }),
    });

    expect(response.status).toBe(400);
    const body = await jsonOf(response);
    expect(body.error).toBe("invalid_input");
    expect(Array.isArray(body.details)).toBe(true);
    const codes = (body.details as { code?: string }[]).map((issue) => issue.code);
    expect(codes).toContain("unrecognized_keys");
    expect(daemon.services.registrarReader.listEntries()).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("GET /registrar/:id for a missing entry returns 404 registrar_not_found", async () => {
  // Mutation: remove the `if (!entry)` guard in registrarGetRoute — the route builds its response for a missing entry and returns 200 (entry null), or throws inside the reader calls, instead of returning 404.
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar/does-not-exist", {
      headers: authHeaders(daemon.token),
    });

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({
      error: "registrar_not_found",
      registrar_id: "does-not-exist",
    });
  } finally {
    daemon.stop();
  }
});

test("GET /registrar/:id/events for a missing entry returns 404 registrar_not_found", async () => {
  // Mutation: remove the getEntry guard in registrarListEventsRoute — the route then returns 200 {events:[]} for a missing entry.
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar/does-not-exist/events", {
      headers: authHeaders(daemon.token),
    });

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({
      error: "registrar_not_found",
      registrar_id: "does-not-exist",
    });
  } finally {
    daemon.stop();
  }
});

test("GET /registrar/:id URL-decodes the path id before the lookup", async () => {
  // Mutation: drop decodeURIComponent in the serve.ts regexRoute for GET /registrar/:id — the raw "no%20such" would be echoed back in registrar_id.
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar/no%20such", {
      headers: authHeaders(daemon.token),
    });

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({
      error: "registrar_not_found",
      registrar_id: "no such",
    });
  } finally {
    daemon.stop();
  }
});
