import {
  RegistrarDetailSchema,
  RegistrarEventKindSchema,
  RegistrarEventSchema,
  RegistrarListResponseSchema,
} from "@penumbra/api-contract";
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
import { z } from "zod";

import { setPrincipalForTest } from "@src/auth.js";
import { registrarAppendRoute, registrarCreateRoute } from "@src/routes/registrar.js";
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

  const root = mkdtempSync(join(tmpdir(), "registrar-route-"));
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

function registrarCreateRequest(): Request {
  return new Request("http://x/registrar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrarCreateInput()),
  });
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

async function createRegistrar(daemon: ReturnType<typeof startTestDaemon>): Promise<string> {
  const response = await daemon.fetch("/registrar", {
    method: "POST",
    headers: authJsonHeaders(daemon.token),
    body: JSON.stringify(registrarCreateInput()),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { registrar_id: string }).registrar_id;
}

test("enum drift trap: every RegistrarEventKindSchema option is accepted by the registrar_events CHECK, and an invented value is rejected by raw db.run", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.run(
    `INSERT INTO registrar_entries
       (registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["registrar-1", "registrar-one", "Registrar one", "penumbra", null, "active", 1, 1],
  );

  const insertKind = (kind: string): void => {
    const state =
      kind === "blocker"
        ? "opened"
        : kind === "follow_up"
          ? "owed"
          : kind === "phase_transition"
            ? "active"
            : kind === "entry_transition"
              ? "complete"
              : null;
    const linkKind = kind === "link" ? "commit_sha" : null;
    const linkValue = kind === "link" ? "abc123" : null;
    db.run(
      `INSERT INTO registrar_events
         (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["registrar-1", null, kind, state, null, linkKind, linkValue, "maestro", kind, 1],
    );
  };

  try {
    for (const kind of RegistrarEventKindSchema.options) insertKind(kind);
    expect(() => {
      insertKind("sabotage");
    }).toThrow();
  } finally {
    db.close();
  }
});

test("POST /registrar with a worker-token principal returns 403", async () => {
  const daemon = startTestDaemon();
  try {
    const req = registrarCreateRequest();
    setPrincipalForTest(req, {
      kind: "worker",
      worker_id: "worker-1",
      token_hash: "hash-1",
    });

    const response = await registrarCreateRoute(req, daemon.services);

    expect(response.status).toBe(403);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events with a worker-token principal returns 403 principal_forbidden", async () => {
  const daemon = startTestDaemon();
  try {
    const entry = daemon.services.registrarWriter.createEntry(registrarCreateInput());
    const req = new Request(`http://x/registrar/${entry.registrar_id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "progress", actor: "worker", body: "worker update" }),
    });
    setPrincipalForTest(req, {
      kind: "worker",
      worker_id: "worker-1",
      token_hash: "hash-1",
    });

    const response = await registrarAppendRoute(req, entry.registrar_id, daemon.services);

    expect(response.status).toBe(403);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "principal_forbidden" }) as unknown,
      }) as unknown,
    );
  } finally {
    daemon.stop();
  }
});

test("POST /registrar as the shared principal creates the entry and its phases in one call, 201 + registrar_id", async () => {
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify(registrarCreateInput()),
    });

    expect(response.status).toBe(201);
    const body = z.strictObject({ registrar_id: z.uuid() }).parse(await response.json());
    expect(daemon.services.registrarReader.getEntry(body.registrar_id)?.title).toBe(
      "Registrar rollout",
    );
    expect(daemon.services.registrarReader.listPhases(body.registrar_id)).toEqual([
      expect.objectContaining({ phase_no: 1, title: "Domain", status: "active" }) as unknown,
      expect.objectContaining({ phase_no: 2, title: "HTTP routes", status: "pending" }) as unknown,
    ]);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events returns a strict RegistrarEventSchema envelope", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ kind: "progress", actor: "maestro", body: "route complete" }),
    });

    expect(response.status).toBe(200);
    const body = z.strictObject({ event: RegistrarEventSchema }).parse(await response.json());
    expect(body.event).toMatchObject({
      registrar_id: registrarId,
      kind: "progress",
      actor: "maestro",
      body: "route complete",
    });
  } finally {
    daemon.stop();
  }
});

test("GET /registrar/:id/events returns the appended event in a strict schema envelope", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);
    const event = daemon.services.registrarWriter.appendEvent(registrarId, {
      kind: "decision",
      actor: "operator",
      body: "ship it",
    });

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      headers: authHeaders(daemon.token),
    });

    expect(response.status).toBe(200);
    const body = z
      .strictObject({ events: z.array(RegistrarEventSchema) })
      .parse(await response.json());
    expect(body.events).toEqual([event]);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events with kind='sabotage' returns 400 invalid_input and a subsequent GET shows zero events", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);
    const append = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ kind: "sabotage", actor: "maestro", body: "break it" }),
    });

    expect(append.status).toBe(400);
    const appendBody: unknown = await append.json();
    expect(appendBody).toEqual(expect.objectContaining({ error: "invalid_input" }) as unknown);

    const list = await daemon.fetch(`/registrar/${registrarId}/events`, {
      headers: authHeaders(daemon.token),
    });
    expect(list.status).toBe(200);
    expect((await list.json()) as { events: unknown[] }).toEqual({ events: [] });
  } finally {
    daemon.stop();
  }
});

// This proves the HTTP mapping (one 200, one 409, no 500), not true contention; the core conditional UPDATE owns atomicity.
test("two concurrent POST /registrar/:id/events phase transitions from the same from_status: one 200, one 409 — not a 500", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);
    const transition = {
      phase_no: 1,
      kind: "phase_transition",
      from_status: "active",
      state: "complete",
      actor: "maestro",
      body: "phase complete",
    };

    const responses = await Promise.all([
      daemon.fetch(`/registrar/${registrarId}/events`, {
        method: "POST",
        headers: authJsonHeaders(daemon.token),
        body: JSON.stringify(transition),
      }),
      daemon.fetch(`/registrar/${registrarId}/events`, {
        method: "POST",
        headers: authJsonHeaders(daemon.token),
        body: JSON.stringify(transition),
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events entry_transition active→complete updates the entry and appends the audit event", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        from_status: "active",
        state: "complete",
        actor: "maestro",
        body: "all phases landed",
      }),
    });

    expect(response.status).toBe(200);
    const body = z.strictObject({ event: RegistrarEventSchema }).parse(await response.json());
    expect(body.event.kind).toBe("entry_transition");
    expect(body.event.state).toBe("complete");
    expect(body.event.phase_no).toBeNull();

    expect(daemon.services.registrarReader.getEntry(registrarId)?.status).toBe("complete");
    expect(
      daemon.services.registrarReader
        .listEvents(registrarId)
        .filter((event) => event.kind === "entry_transition"),
    ).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events entry_transition with a wrong from_status returns 409 invalid_entry_transition and appends no event", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        from_status: "paused",
        state: "abandoned",
        actor: "maestro",
        body: "should not apply",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: "invalid_entry_transition" }),
    );
    expect(daemon.services.registrarReader.getEntry(registrarId)?.status).toBe("active");
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events entry_transition against an unknown registrar returns 404 registrar_not_found", async () => {
  const daemon = startTestDaemon();
  try {
    const response = await daemon.fetch("/registrar/does-not-exist/events", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        from_status: "active",
        state: "complete",
        actor: "maestro",
        body: "no such entry",
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: "registrar_not_found" }),
    );
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events entry_transition complete→active re-open round-trips 200", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const close = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        from_status: "active",
        state: "complete",
        actor: "maestro",
        body: "closed early",
      }),
    });
    expect(close.status).toBe(200);

    const reopen = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        from_status: "complete",
        state: "active",
        actor: "maestro",
        body: "re-opened",
      }),
    });
    expect(reopen.status).toBe(200);

    expect(daemon.services.registrarReader.getEntry(registrarId)?.status).toBe("active");
    expect(
      daemon.services.registrarReader
        .listEvents(registrarId)
        .filter((event) => event.kind === "entry_transition"),
    ).toHaveLength(2);
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events entry_transition with state='draft' returns 400 invalid_input", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        from_status: "active",
        state: "draft",
        actor: "maestro",
        body: "draft is creation-only",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "invalid_input" }));
    expect(daemon.services.registrarReader.getEntry(registrarId)?.status).toBe("active");
  } finally {
    daemon.stop();
  }
});

test("POST /registrar/:id/events entry_transition with phase_no returns 400 invalid_input", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);

    const response = await daemon.fetch(`/registrar/${registrarId}/events`, {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({
        kind: "entry_transition",
        phase_no: 1,
        from_status: "active",
        state: "complete",
        actor: "maestro",
        body: "entry transitions are entry-scoped",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "invalid_input" }));
    expect(daemon.services.registrarReader.listEvents(registrarId)).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("GET /registrar returns open_blockers/open_followups/phase progress matching RegistrarListResponseSchema", async () => {
  const daemon = startTestDaemon();
  try {
    const registrarId = await createRegistrar(daemon);
    daemon.services.registrarWriter.appendEvent(registrarId, {
      phase_no: 1,
      kind: "blocker",
      state: "opened",
      actor: "maestro",
      body: "Need daemon routes",
    });
    daemon.services.registrarWriter.appendEvent(registrarId, {
      phase_no: 2,
      kind: "follow_up",
      state: "owed",
      actor: "maestro",
      body: "Add MCP surface later",
    });
    daemon.services.registrarWriter.appendEvent(registrarId, {
      phase_no: 1,
      kind: "phase_transition",
      from_status: "active",
      state: "complete",
      actor: "maestro",
      body: "Domain phase complete",
    });

    const list = await daemon.fetch("/registrar", { headers: authHeaders(daemon.token) });
    expect(list.status).toBe(200);
    const listBody = RegistrarListResponseSchema.parse(await list.json());
    expect(listBody.entries).toHaveLength(1);
    expect(listBody.entries[0]?.registrar_id).toBe(registrarId);

    const detail = await daemon.fetch(`/registrar/${registrarId}`, {
      headers: authHeaders(daemon.token),
    });
    expect(detail.status).toBe(200);
    const detailBody = RegistrarDetailSchema.parse(await detail.json());
    expect(detailBody.rollup).toEqual({ open_blockers: 1, open_follow_ups: 1 });
    expect(detailBody.phases).toEqual([
      expect.objectContaining({ phase_no: 1, status: "complete" }) as unknown,
      expect.objectContaining({ phase_no: 2, status: "pending" }) as unknown,
    ]);
  } finally {
    daemon.stop();
  }
});

test("after one appended blocker event, GET /registrar entries[0].rollup is {open_blockers:1, open_follow_ups:0} and RegistrarListResponseSchema.safeParse(body).success", async () => {
  const daemon = startTestDaemon();
  try {
    const id = await createRegistrar(daemon);
    daemon.services.registrarWriter.appendEvent(id, {
      phase_no: 1,
      kind: "blocker",
      state: "opened",
      actor: "maestro",
      body: "x",
    });

    const res = await daemon.fetch("/registrar", { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { entries: { rollup?: unknown }[] };
    expect(raw.entries[0]?.rollup).toEqual({ open_blockers: 1, open_follow_ups: 0 });
    expect(RegistrarListResponseSchema.safeParse(raw).success).toBe(true);
    expect(RegistrarListResponseSchema.parse(raw).entries[0]?.rollup).toEqual(
      daemon.services.registrarReader.getRollup(id),
    );
  } finally {
    daemon.stop();
  }
});

test("with two phases of which one is complete, GET /registrar entries[0].phase_progress is {complete:1, total:2} and the entry still parses", async () => {
  const daemon = startTestDaemon();
  try {
    const id = await createRegistrar(daemon);
    const emptyId = daemon.services.registrarWriter.createEntry({
      ...registrarCreateInput(),
      slug: "empty-phases",
      title: "Empty phases",
    }).registrar_id;
    daemon.services.db.run("DELETE FROM registrar_phases WHERE registrar_id = ?", [emptyId]);

    daemon.services.registrarWriter.appendEvent(id, {
      phase_no: 1,
      kind: "phase_transition",
      from_status: "active",
      state: "complete",
      actor: "maestro",
      body: "Domain phase complete",
    });

    const res = await daemon.fetch("/registrar", { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const raw = (await res.json()) as {
      entries: { registrar_id: string; phase_progress?: unknown }[];
    };

    const firstEntry = raw.entries.find((entry) => entry.registrar_id === id);
    expect(firstEntry).toBeDefined();
    expect(firstEntry?.phase_progress).toEqual({ complete: 1, total: 2 });
    expect(RegistrarListResponseSchema.safeParse(raw).success).toBe(true);
    expect(
      RegistrarListResponseSchema.parse(raw).entries.find((entry) => entry.registrar_id === id)
        ?.phase_progress,
    ).toEqual(daemon.services.registrarReader.getPhaseProgress(id));

    const emptyEntry = raw.entries.find((entry) => entry.registrar_id === emptyId);
    expect(emptyEntry?.phase_progress).toEqual({ complete: 0, total: 0 });
  } finally {
    daemon.stop();
  }
});

test("with PENUMBRA_REGISTRAR=0 the routes are not mounted (404)", async () => {
  const previous = process.env.PENUMBRA_REGISTRAR;
  process.env.PENUMBRA_REGISTRAR = "0";
  const daemon = startTestDaemon();
  try {
    const entry = daemon.services.registrarWriter.createEntry(registrarCreateInput());
    const requests: [string, RequestInit?][] = [
      [
        "/registrar",
        {
          method: "POST",
          headers: authJsonHeaders(daemon.token),
          body: JSON.stringify({ ...registrarCreateInput(), slug: "another-registrar" }),
        },
      ],
      ["/registrar", { headers: authHeaders(daemon.token) }],
      [`/registrar/${entry.registrar_id}`, { headers: authHeaders(daemon.token) }],
      [
        `/registrar/${entry.registrar_id}/events`,
        {
          method: "POST",
          headers: authJsonHeaders(daemon.token),
          body: JSON.stringify({ kind: "progress", actor: "maestro", body: "hidden" }),
        },
      ],
      [`/registrar/${entry.registrar_id}/events`, { headers: authHeaders(daemon.token) }],
    ];

    for (const [path, init] of requests) {
      expect((await daemon.fetch(path, init)).status).toBe(404);
    }
  } finally {
    daemon.stop();
    if (previous === undefined) delete process.env.PENUMBRA_REGISTRAR;
    else process.env.PENUMBRA_REGISTRAR = previous;
  }
});
