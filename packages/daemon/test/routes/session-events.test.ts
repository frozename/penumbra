import {
  SessionEventsListResponseSchema,
  SessionNoteApproveResponseSchema,
} from "@penumbra/api-contract";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  SessionNoteDrafts,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import {
  buildRegistry,
  type Registry,
  type WorkflowFn,
  type WorkflowSpec,
} from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

interface Harness {
  services: Services;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): void;
}

function startHarness(
  opts: {
    workflowRegistry?: Services["workflowRegistry"];
    projectRegistry?: Services["projectRegistry"];
  } = {},
): Harness {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "session-events-route-"));
  const token = "tok";
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-01T00:00:03.000Z"),
    workflowRegistry: opts.workflowRegistry,
    projectRegistry: opts.projectRegistry,
  });
  const handler = createDaemonFetchHandler({ services, token });
  return {
    services,
    fetch(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return handler(new Request(`http://x${path}`, { ...init, headers }));
    },
    stop(): void {
      services.supervisor.stopAll();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function seedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "boot-pickup-repo-"));
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email t@t", { cwd: repo });
  execSync("git config user.name t", { cwd: repo });
  execSync("git remote add origin https://example.test/penumbra.git", { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  execSync('git add tracked.txt && git commit -q -m "init"', { cwd: repo, shell: "/bin/bash" });
  return repo;
}

async function bootPickupHarness(
  names: string[] = ["maestro-context-prime"],
): Promise<{ harness: Harness; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), "boot-pickup-playbooks-"));
  for (const name of names) {
    const playbookDir = join(root, `playbooks/${name}`);
    mkdirSync(playbookDir, { recursive: true });
    writeFileSync(
      join(playbookDir, "playbook.md"),
      `---\nname: ${name}\ndescription: boot pickup\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall:\n  - source: latest_continuation_note\n    args: {}\n  - source: session_first_moves\n    args: {}\noutput:\n  - kind: session-reminder\nrun:\n  kind: markdown-template\n---\n{{recall.latest_continuation_note.body}}\n{{recall.session_first_moves.head_sha}}\n`,
    );
  }
  mkdirSync(join(root, "workflows"), { recursive: true });
  const repo = seedRepo();
  const harness = startHarness({
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    ),
    workflowRegistry: await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    }),
  });
  const originalStop = harness.stop.bind(harness);
  harness.stop = (): void => {
    originalStop();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  };
  return { harness, repo };
}

type ContinuityPlaybookOpts = {
  name?: string;
  trigger?: string;
  output?: string;
  outputPath?: string;
  body: string;
};

type SessionEventRows = ReturnType<typeof SessionEventsListResponseSchema.parse>["events"];

async function continuityHarness(
  opts: ContinuityPlaybookOpts,
): Promise<{ harness: Harness; repo: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "continuity-playbooks-"));
  const name = opts.name ?? "session-handoff";
  const playbookDir = join(root, `playbooks/${name}`);
  mkdirSync(playbookDir, { recursive: true });
  writeFileSync(
    join(playbookDir, "playbook.md"),
    `---\nname: ${name}\ndescription: continuity fixture\ntriggers:\n${opts.trigger ?? "  - kind: lifecycle\n    event: pre-compact"}\nrecall: []\noutput:\n${opts.output ?? `  - kind: file\n    path: ${opts.outputPath ?? "docs/notes/maestro-continuation-{{date}}-{{period}}.skeleton.md"}\n    mode: overwrite`}\nrun:\n  kind: markdown-template\n---\n${opts.body}`,
  );
  mkdirSync(join(root, "workflows"), { recursive: true });
  const repo = seedRepo();
  const harness = startHarness({
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    ),
    workflowRegistry: await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    }),
  });
  const originalStop = harness.stop.bind(harness);
  harness.stop = (): void => {
    originalStop();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  };
  return { harness, repo, root };
}

function spec(name: string): WorkflowSpec {
  return {
    name,
    description: `${name} fixture`,
    triggers: [{ kind: "lifecycle", event: "pre-compact" }],
    recall: [],
    output: [],
    run: { kind: "ts-function" },
  };
}

function registryFromEntries(
  entries: {
    spec: WorkflowSpec;
    fn: WorkflowFn;
  }[],
): Registry {
  return {
    list: () => entries.map((entry) => entry.spec),
    entries: () =>
      entries.map((entry) => ({ ...entry, source: "ts" as const, path: entry.spec.name })),
    get: (name) => entries.find((entry) => entry.spec.name === name)?.spec,
    getEntry: (name): ReturnType<Registry["getEntry"]> => {
      const entry = entries.find((candidate) => candidate.spec.name === name);
      return entry ? { ...entry, source: "ts" as const, path: entry.spec.name } : undefined;
    },
    findByTrigger: () => entries.map((entry) => entry.spec),
    errors: [],
  };
}

async function triggerWorkflow(
  h: Harness,
  repo: string,
  event: Record<string, unknown> = { kind: "lifecycle", event: "pre-compact" },
): Promise<void> {
  const res = await h.fetch("/workflows/trigger", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      event,
      cwd: repo,
      session_id: "s-continuity",
      transcript_path: "/tmp/transcript-continuity.jsonl",
    }),
  });
  if (res.status !== 200) {
    throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
  }
}

async function listContinuityEvents(h: Harness): Promise<SessionEventRows> {
  const get = await h.fetch("/session-events?kind_prefix=continuity.");
  if (get.status !== 200) {
    throw new Error(`unexpected status ${String(get.status)}: ${await get.text()}`);
  }
  const body: unknown = await get.json();
  return SessionEventsListResponseSchema.parse(body).events;
}

function onlyContinuityEvent(
  events: Awaited<ReturnType<typeof listContinuityEvents>>,
  kind: string,
): SessionEventRows[number] {
  const filtered = events.filter((event) => event.kind === kind);
  expect(filtered).toHaveLength(1);
  return filtered[0]!;
}

function findSkeletonPath(repo: string): string {
  const dir = join(repo, "docs/notes");
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  const skeleton = entries.find((entry) => entry.endsWith(".skeleton.md"));
  if (!skeleton) throw new Error("expected skeleton output");
  return join(realpathSync(repo), "docs/notes", skeleton);
}

test("POST /session-events with an unknown kind returns 400", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        events: [
          {
            session_id: "s-1",
            kind: "session.unknown",
            ts: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
  } finally {
    h.stop();
  }
});

test("POST /session-events accepts string meta", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        events: [
          {
            session_id: "s-string-meta",
            kind: "session.start",
            ts: "2026-05-01T00:00:00.000Z",
            meta: "plain meta",
          },
        ],
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const get = await h.fetch("/session-events?session_id=s-string-meta");
    const body: unknown = await get.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events[0]?.meta).toBe("plain meta");
  } finally {
    h.stop();
  }
});

test("POST /session-events rejects oversized meta with 400 and no partial insert", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        events: [
          {
            session_id: "s-huge-meta",
            kind: "session.start",
            ts: "2026-05-01T00:00:00.000Z",
            meta: { blob: "x".repeat(8190) },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) throw new Error("expected error body");
    const errorBody = body as { error?: unknown; message?: unknown };
    expect(errorBody.error).toBe("meta_too_large");
    if (typeof errorBody.message !== "string") throw new Error("expected string error message");
    expect(errorBody.message).toContain("meta JSON must be <= 8192 bytes");
    const row = h.services.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_events")
      .get();
    expect(row?.count).toBe(0);
  } finally {
    h.stop();
  }
});

test("GET /session-events?kind_prefix=continuity. returns rows newest-first", async () => {
  const h = startHarness();
  try {
    h.services.db.run(`
      INSERT INTO session_events (session_id, kind, ts, meta_json)
      VALUES
        ('s-1', 'continuity.draft_composed', '2026-05-01T00:00:00.000Z', '{"n":1}'),
        ('s-1', 'session.start', '2026-05-01T00:00:01.000Z', NULL),
        ('s-2', 'continuity.boot_pickup', '2026-05-01T00:00:02.000Z', '{"n":2}');
    `);

    const res = await h.fetch("/session-events?kind_prefix=continuity.");
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const body: unknown = await res.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events.map((event) => event.kind)).toEqual([
      "continuity.boot_pickup",
      "continuity.draft_composed",
    ]);
    expect(parsed.events[0]?.meta).toEqual({ n: 2 });
  } finally {
    h.stop();
  }
});

test("POST /workflows/trigger with hook_event_name=SessionEnd persists one session.end row", async () => {
  const h = startHarness({
    workflowRegistry: {
      list: () => [],
      entries: () => [],
      get: () => undefined,
      getEntry: () => undefined,
      findByTrigger: () => [],
      errors: [],
    },
  });
  try {
    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-end" },
        hook_event_name: "SessionEnd",
        cwd: process.cwd(),
        session_id: "s-end",
        transcript_path: "/tmp/transcript.jsonl",
      }),
    });
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }

    const rows = h.services.db
      .query<
        { session_id: string; kind: string; transcript_path: string | null },
        []
      >("SELECT session_id, kind, transcript_path FROM session_events")
      .all();
    expect(rows).toEqual([
      { session_id: "s-end", kind: "session.end", transcript_path: "/tmp/transcript.jsonl" },
    ]);
  } finally {
    h.stop();
  }
});

test("trigger-ingested event without session_id stores NULL and GET /session-events validates", async () => {
  const h = startHarness({
    workflowRegistry: {
      list: () => [],
      entries: () => [],
      get: () => undefined,
      getEntry: () => undefined,
      findByTrigger: () => [],
      errors: [],
    },
  });
  try {
    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "stop" },
        cwd: process.cwd(),
      }),
    });
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }

    const row = h.services.db
      .query<
        { session_id: string | null; kind: string },
        []
      >("SELECT session_id, kind FROM session_events")
      .get();
    expect(row).toEqual({ session_id: null, kind: "session.stop" });

    const get = await h.fetch("/session-events?kind_prefix=session.");
    expect(get.status).toBe(200);
    const body: unknown = await get.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.session_id).toBeNull();
  } finally {
    h.stop();
  }
});

test("a session-start trigger resolving a note records continuity.boot_pickup with ref_path, first-moves meta, and related_session_id parsed from the note's session stamp", async () => {
  const { harness: h, repo } = await bootPickupHarness();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    const notePath = join(repo, "docs/notes/maestro-continuation-2026-05-05.md");
    const related = "123e4567-e89b-12d3-a456-426614174000";
    writeFileSync(notePath, `<!-- penumbra:session ${related} -->\nBoot body\n`);

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.boot_pickup");
    expect(event.related_session_id).toBe(related);
    expect(event.ref_path).toBe(realpathSync(notePath));
    const row = h.services.db
      .query<
        {
          session_id: string | null;
          related_session_id: string | null;
          kind: string;
          ref_path: string | null;
          meta_json: string | null;
        },
        []
      >(
        "SELECT session_id, related_session_id, kind, ref_path, meta_json FROM session_events WHERE kind='continuity.boot_pickup'",
      )
      .get();
    expect(row?.session_id).toBe("s-new");
    expect(row?.related_session_id).toBe(related);
    expect(row?.kind).toBe("continuity.boot_pickup");
    expect(row?.ref_path).toBe(realpathSync(notePath));
    const meta: unknown = row?.meta_json ? JSON.parse(row.meta_json) : null;
    if (typeof meta !== "object" || meta === null) throw new Error("expected boot pickup meta");
    const firstMoves = (meta as { first_moves?: unknown }).first_moves;
    if (typeof firstMoves !== "object" || firstMoves === null) {
      throw new Error("expected first_moves object");
    }
    expect(typeof (firstMoves as { head_sha?: unknown }).head_sha).toBe("string");
  } finally {
    h.stop();
  }
});

test("a title-first continuation note can still link related_session_id from the first five lines", async () => {
  const { harness: h, repo } = await bootPickupHarness();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    const notePath = join(repo, "docs/notes/maestro-continuation-2026-05-07.md");
    const related = "123e4567-e89b-12d3-a456-426614174111";
    writeFileSync(notePath, `# Continuation\n\n<!-- penumbra:session ${related} -->\nBoot body\n`);

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.boot_pickup");
    expect(event.related_session_id).toBe(related);
    expect(event.ref_path).toBe(realpathSync(notePath));
    const row = h.services.db
      .query<
        { related_session_id: string | null; ref_path: string | null },
        []
      >("SELECT related_session_id, ref_path FROM session_events WHERE kind='continuity.boot_pickup'")
      .get();
    expect(row).toEqual({ related_session_id: related, ref_path: realpathSync(notePath) });
  } finally {
    h.stop();
  }
});

test("boot pickup record failure is reported false so a later matched workflow can retry once", async () => {
  const { harness: h, repo } = await bootPickupHarness([
    "maestro-context-prime-a",
    "maestro-context-prime-b",
  ]);
  const sessionEventLog = h.services.sessionEventLog;
  const originalRecord = sessionEventLog.record.bind(sessionEventLog);
  let bootPickupAttempts = 0;
  sessionEventLog.record = (event): number => {
    if (event.kind === "continuity.boot_pickup") {
      bootPickupAttempts += 1;
      if (bootPickupAttempts === 1) {
        throw new Error("simulated record failure");
      }
    }
    return originalRecord(event);
  };
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    writeFileSync(join(repo, "docs/notes/maestro-continuation-2026-05-08.md"), "Boot body\n");

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const row = h.services.db
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM session_events WHERE kind='continuity.boot_pickup'")
      .get();
    expect(bootPickupAttempts).toBe(2);
    expect(row?.count).toBe(1);
  } finally {
    sessionEventLog.record = originalRecord;
    h.stop();
  }
});

test("related_session_id is null, not an error, when the note carries no stamp", async () => {
  const { harness: h, repo } = await bootPickupHarness();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    const notePath = join(repo, "docs/notes/maestro-continuation-2026-05-06.md");
    writeFileSync(notePath, "Boot body without stamp\n");

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const row = h.services.db
      .query<
        { related_session_id: string | null; ref_path: string | null },
        []
      >("SELECT related_session_id, ref_path FROM session_events WHERE kind='continuity.boot_pickup'")
      .get();
    expect(row).toEqual({ related_session_id: null, ref_path: realpathSync(notePath) });
  } finally {
    h.stop();
  }
});

test("a session-handoff run records continuity.skeleton_generated with ref_path and the session stamp in meta", async () => {
  const stamp = "123e4567-e89b-12d3-a456-426614174222";
  const { harness: h, repo } = await continuityHarness({
    body: `<!-- penumbra:session ${stamp} -->\nSkeleton body\n`,
  });
  try {
    await triggerWorkflow(h, repo);

    const skeletonPath = findSkeletonPath(repo);
    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.skeleton_generated");
    expect(event.session_id).toBe("s-continuity");
    expect(event.project_id).toBe("penumbra");
    expect(event.cwd).toBe(repo);
    expect(event.transcript_path).toBe("/tmp/transcript-continuity.jsonl");
    expect(event.ref_path).toBe(skeletonPath);
    if (typeof event.meta !== "object" || event.meta === null) {
      throw new Error("expected skeleton meta object");
    }
    const meta = event.meta as {
      session_stamp?: unknown;
      byte_size?: unknown;
      period_key?: unknown;
    };
    expect(meta.session_stamp).toBe(stamp);
    expect(typeof meta.byte_size).toBe("number");
    expect((meta.byte_size as number) > 0).toBe(true);
    expect(typeof meta.period_key).toBe("string");
  } finally {
    h.stop();
  }
});

test("skeleton_generated reads the session stamp from the first five skeleton lines", async () => {
  const stamp = "123e4567-e89b-12d3-a456-426614174223";
  const { harness: h, repo } = await continuityHarness({
    body: `{{recall.missing}}\n<!-- penumbra:session ${stamp} -->\nSkeleton body\n`,
  });
  try {
    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.skeleton_generated");
    if (typeof event.meta !== "object" || event.meta === null) {
      throw new Error("expected skeleton meta object");
    }
    expect((event.meta as { session_stamp?: unknown }).session_stamp).toBe(stamp);
  } finally {
    h.stop();
  }
});

test("a session-handoff skeleton ref_path resolves back to the source session", async () => {
  const stamp = "123e4567-e89b-12d3-a456-426614174333";
  const { harness: h, repo } = await continuityHarness({
    outputPath: "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md",
    body: `<!-- penumbra:session ${stamp} -->\nSkeleton body\n`,
  });
  try {
    await triggerWorkflow(h, repo);

    const skeletonPath = join(
      realpathSync(repo),
      "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md",
    );
    expect(h.services.sessionEventLog.resolveSourceSessionForNote(skeletonPath)).toBe(
      "s-continuity",
    );
  } finally {
    h.stop();
  }
});

test("a symlinked notes directory records the logical skeleton ref_path", async () => {
  const outputPath = "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md";
  const { harness: h, repo } = await continuityHarness({
    outputPath,
    body: "Skeleton body\n",
  });
  try {
    const physicalNotesDir = join(repo, "docs/notes-target");
    rmSync(join(repo, "docs"), { recursive: true, force: true });
    mkdirSync(physicalNotesDir, { recursive: true });
    symlinkSync(physicalNotesDir, join(repo, "docs/notes"), "dir");
    const logicalBarePath = join(
      realpathSync(repo),
      "docs/notes/maestro-continuation-2026-05-01-am.md",
    );
    writeFileSync(logicalBarePath, "operator note bytes\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(logicalBarePath, future, future);

    await triggerWorkflow(h, repo);

    const logicalSkeletonPath = join(realpathSync(repo), outputPath);
    const physicalSkeletonPath = realpathSync(logicalSkeletonPath);
    expect(physicalSkeletonPath).not.toBe(logicalSkeletonPath);
    const physicalBarePath = realpathSync(logicalBarePath);
    expect(physicalBarePath).not.toBe(logicalBarePath);
    const events = await listContinuityEvents(h);
    const skeletonEvent = onlyContinuityEvent(events, "continuity.skeleton_generated");
    expect(skeletonEvent.ref_path).toBe(logicalSkeletonPath);
    expect(skeletonEvent.ref_path).not.toBe(physicalSkeletonPath);
    const supersededEvent = onlyContinuityEvent(events, "continuity.note_superseded");
    expect(supersededEvent.ref_path).toBe(logicalBarePath);
    expect(supersededEvent.ref_path).not.toBe(physicalBarePath);
    if (typeof supersededEvent.meta !== "object" || supersededEvent.meta === null) {
      throw new Error("expected note superseded meta object");
    }
    expect((supersededEvent.meta as { skeleton_path?: unknown }).skeleton_path).toBe(
      logicalSkeletonPath,
    );
  } finally {
    h.stop();
  }
});

test("skeleton_generated reads the session stamp from a large skeleton body", async () => {
  const stamp = "123e4567-e89b-12d3-a456-426614174444";
  const { harness: h, repo } = await continuityHarness({
    body: `<!-- penumbra:session ${stamp} -->\n${"x".repeat(70 * 1024)}\n`,
  });
  try {
    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.skeleton_generated");
    if (typeof event.meta !== "object" || event.meta === null) {
      throw new Error("expected skeleton meta object");
    }
    expect((event.meta as { session_stamp?: unknown }).session_stamp).toBe(stamp);
  } finally {
    h.stop();
  }
});

test("skeleton_generated records session_stamp null when the skeleton has no stamp", async () => {
  const { harness: h, repo } = await continuityHarness({
    body: "Skeleton body without stamp\n",
  });
  const warnCalls: unknown[] = [];
  const originalWarn = h.services.log.warn.bind(h.services.log);
  h.services.log.warn = (obj: unknown, msg?: string): void => {
    warnCalls.push({ obj, msg });
  };
  try {
    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.skeleton_generated");
    if (typeof event.meta !== "object" || event.meta === null) {
      throw new Error("expected skeleton meta object");
    }
    expect((event.meta as { session_stamp?: unknown }).session_stamp).toBeNull();
    expect(warnCalls).toHaveLength(0);
  } finally {
    h.services.log.warn = originalWarn;
    h.stop();
  }
});

test("when a bare-named note newer than the skeleton exists, continuity.note_superseded is recorded and nothing is blocked", async () => {
  const outputPath = "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md";
  const { harness: h, repo } = await continuityHarness({
    outputPath,
    body: "Skeleton body\n",
  });
  try {
    const barePath = join(repo, "docs/notes/maestro-continuation-2026-05-01-am.md");
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    writeFileSync(barePath, "operator note bytes\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(barePath, future, future);

    await triggerWorkflow(h, repo);

    expect(readFileSync(barePath, "utf8")).toBe("operator note bytes\n");
    const logicalBarePath = join(
      realpathSync(repo),
      "docs/notes/maestro-continuation-2026-05-01-am.md",
    );
    const logicalSkeletonPath = join(realpathSync(repo), outputPath);
    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.note_superseded");
    expect(event.ref_path).toBe(logicalBarePath);
    if (typeof event.meta !== "object" || event.meta === null) {
      throw new Error("expected note superseded meta object");
    }
    const meta = event.meta as {
      skeleton_path?: unknown;
      note_mtime?: unknown;
      skeleton_mtime?: unknown;
    };
    expect(meta.skeleton_path).toBe(logicalSkeletonPath);
    expect(typeof meta.note_mtime).toBe("string");
    expect(typeof meta.skeleton_mtime).toBe("string");
  } finally {
    h.stop();
  }
});

test("an older bare-named sibling records no note_superseded row", async () => {
  const outputPath = "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md";
  const { harness: h, repo } = await continuityHarness({
    outputPath,
    body: "Skeleton body\n",
  });
  try {
    const barePath = join(repo, "docs/notes/maestro-continuation-2026-05-01-am.md");
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    writeFileSync(barePath, "older operator note\n");
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(barePath, past, past);

    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    expect(events.filter((event) => event.kind === "continuity.note_superseded")).toHaveLength(0);
  } finally {
    h.stop();
  }
});

test("a non-session-handoff workflow run records no continuity rows", async () => {
  const { harness: h, repo } = await continuityHarness({
    name: "session-reminder-fixture",
    outputPath: "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md",
    body: "Reminder body\n",
  });
  try {
    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    expect(events).toHaveLength(0);
  } finally {
    h.stop();
  }
});

test("a session-handoff run with a non-maestro skeleton basename records no continuity rows", async () => {
  const { harness: h, repo } = await continuityHarness({
    outputPath: "docs/notes/session-handoff.skeleton.md",
    body: "Skeleton body\n",
  });
  try {
    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    expect(events).toHaveLength(0);
  } finally {
    h.stop();
  }
});

test("matched trigger specs execute in name order", async () => {
  const repo = seedRepo();
  const executionOrder: string[] = [];
  const handoff = spec("session-handoff");
  const draft = spec("session-handoff-draft");
  const h = startHarness({
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    ),
    workflowRegistry: registryFromEntries([
      {
        spec: draft,
        fn: (): Promise<Record<string, never>> => {
          executionOrder.push("session-handoff-draft");
          return Promise.resolve({});
        },
      },
      {
        spec: handoff,
        fn: (): Promise<Record<string, never>> => {
          executionOrder.push("session-handoff");
          return Promise.resolve({});
        },
      },
    ]),
  });
  try {
    await triggerWorkflow(h, repo);

    expect(executionOrder).toEqual(["session-handoff", "session-handoff-draft"]);
  } finally {
    h.stop();
    rmSync(repo, { recursive: true, force: true });
  }
});

function sessionHandoffDraftFn(capturedArgs?: Record<string, unknown>[]): WorkflowFn {
  return async (ctx) => {
    capturedArgs?.push(ctx.args);
    const periodKey = "2026-05-01-am";
    const skeletonPath = await ctx.fileWrite(
      `./docs/notes/maestro-continuation-${periodKey}.skeleton.md`,
      "<!-- penumbra:session s-continuity -->\nSkeleton\n",
    );
    const draftPath = await ctx.fileWrite(
      `./docs/notes/maestro-continuation-${periodKey}.draft.md`,
      [
        "<!-- penumbra:session s-continuity -->",
        "Skeleton",
        "",
        "## Narrative and traps learned",
        "",
        "A grounded narrative.",
        "",
        "## Open follow-ups (worst-first)",
        "",
        "- Review the draft.",
      ].join("\n"),
    );
    const draftId = "draft-route-1";
    new SessionNoteDrafts(ctx.db!()).registerDraft({
      draft_id: draftId,
      session_id: "s-continuity",
      project_id: ctx.project,
      period_key: periodKey,
      skeleton_path: skeletonPath,
      draft_path: draftPath,
      note_path: draftPath.replace(/\.draft\.md$/, ".md"),
      handoff_id: "handoff-route-1",
      composed_at: "2026-05-01T00:00:02.000Z",
      composed_event_id: null,
    });
    return {
      draft_id: draftId,
      handoff_id: "handoff-route-1",
      draft_path: draftPath,
      skeleton_path: skeletonPath,
      period_key: periodKey,
      sections: 2,
    };
  };
}

function draftRouteHarness(): {
  harness: Harness;
  repo: string;
  capturedArgs: Record<string, unknown>[];
} {
  const repo = seedRepo();
  const capturedArgs: Record<string, unknown>[] = [];
  const workflow = spec("session-handoff-draft");
  const harness = startHarness({
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    ),
    workflowRegistry: registryFromEntries([
      { spec: workflow, fn: sessionHandoffDraftFn(capturedArgs) },
    ]),
  });
  const originalStop = harness.stop.bind(harness);
  harness.stop = (): void => {
    originalStop();
    rmSync(repo, { recursive: true, force: true });
  };
  return { harness, repo, capturedArgs };
}

test("a session-handoff-draft run records continuity.draft_composed and stamps composed_event_id", async () => {
  const { harness: h, repo, capturedArgs } = draftRouteHarness();
  const sessionEventLog = h.services.sessionEventLog;
  const originalRecord = sessionEventLog.record.bind(sessionEventLog);
  sessionEventLog.record = (event): number => {
    const insertedId = originalRecord(event);
    if (event.kind !== "continuity.draft_composed") return insertedId;
    originalRecord({
      session_id: "s-interleaved",
      related_session_id: null,
      project_id: "penumbra",
      cwd: repo,
      transcript_path: null,
      ref_path: null,
      kind: "session.start",
      ts: "2026-05-01T00:00:03.000Z",
      meta: null,
    });
    return insertedId;
  };
  try {
    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "pre-compact" },
        cwd: repo,
        session_id: "s-continuity",
        transcript_path: "/tmp/transcript-continuity.jsonl",
        args: { operator_arg: "kept" },
      }),
    });
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }

    expect(capturedArgs).toEqual([
      {
        operator_arg: "kept",
        session_id: "s-continuity",
        transcript_path: "/tmp/transcript-continuity.jsonl",
        repo_root: realpathSync(repo),
      },
    ]);
    const draft = h.services.sessionNoteDrafts.get("draft-route-1");
    if (!draft || typeof draft.composed_event_id !== "number") {
      throw new Error("expected stamped draft row");
    }
    const events = await listContinuityEvents(h);
    const event = onlyContinuityEvent(events, "continuity.draft_composed");
    expect(event.id).toBe(draft.composed_event_id);
    const interleaved = h.services.db
      .query<
        { id: number },
        []
      >("SELECT id FROM session_events WHERE session_id='s-interleaved' AND kind='session.start'")
      .get();
    expect(interleaved?.id).not.toBe(draft.composed_event_id);
    expect(event.session_id).toBe("s-continuity");
    expect(event.project_id).toBe("penumbra");
    expect(event.cwd).toBe(repo);
    expect(event.transcript_path).toBe("/tmp/transcript-continuity.jsonl");
    expect(event.ref_path).toBe(draft.draft_path);
    expect(event.meta).toEqual({
      draft_id: "draft-route-1",
      handoff_id: "handoff-route-1",
      sections: 2,
      skeleton_path: draft.skeleton_path,
    });
  } finally {
    sessionEventLog.record = originalRecord;
    h.stop();
  }
});

test("oversized session-handoff-draft runResult is ignored and warned without draft telemetry", async () => {
  const repo = seedRepo();
  const periodKey = "2026-05-01-am";
  const draftId = "draft-route-huge-result";
  const warnCalls: unknown[] = [];
  const workflow = spec("session-handoff-draft");
  const h = startHarness({
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    ),
    workflowRegistry: registryFromEntries([
      {
        spec: workflow,
        fn: async (ctx): Promise<Record<string, unknown>> => {
          const skeletonPath = await ctx.fileWrite(
            `./docs/notes/maestro-continuation-${periodKey}.skeleton.md`,
            "Skeleton\n",
          );
          const draftPath = await ctx.fileWrite(
            `./docs/notes/maestro-continuation-${periodKey}.draft.md`,
            "Skeleton\n\n## Narrative and traps learned\n\nBody\n\n## Open follow-ups (worst-first)\n\n- Item\n",
          );
          new SessionNoteDrafts(ctx.db!()).registerDraft({
            draft_id: draftId,
            session_id: "s-continuity",
            project_id: ctx.project,
            period_key: periodKey,
            skeleton_path: skeletonPath,
            draft_path: draftPath,
            note_path: draftPath.replace(/\.draft\.md$/, ".md"),
            handoff_id: "handoff-route-huge",
            composed_at: "2026-05-01T00:00:02.000Z",
            composed_event_id: null,
          });
          return {
            draft_id: draftId,
            handoff_id: "handoff-route-huge",
            draft_path: draftPath,
            skeleton_path: skeletonPath,
            period_key: periodKey,
            sections: 2,
            blob: "x".repeat(70 * 1024),
          };
        },
      },
    ]),
  });
  const originalWarn = h.services.log.warn.bind(h.services.log);
  h.services.log.warn = (obj: unknown, msg?: string): void => {
    warnCalls.push({ obj, msg });
  };
  const originalStop = h.stop.bind(h);
  h.stop = (): void => {
    originalStop();
    rmSync(repo, { recursive: true, force: true });
  };
  try {
    await triggerWorkflow(h, repo);

    expect(
      h.services.db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM session_events WHERE kind='continuity.draft_composed'")
        .get()?.count,
    ).toBe(0);
    expect(h.services.sessionNoteDrafts.get(draftId)?.composed_event_id).toBeNull();
    expect(
      warnCalls.some(
        (call) =>
          typeof (call as { msg?: unknown }).msg === "string" &&
          (call as { msg: string }).msg.includes("session-handoff-draft run result ignored"),
      ),
    ).toBe(true);
  } finally {
    h.services.log.warn = originalWarn;
    h.stop();
  }
});

test("approve route pairs draft_composed by composed_event_id after a draft workflow run", async () => {
  const { harness: h, repo } = draftRouteHarness();
  try {
    await triggerWorkflow(h, repo);

    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: "draft-route-1", approve: true }),
    });

    expect(res.status).toBe(200);
    const body = SessionNoteApproveResponseSchema.parse(await res.json());
    expect(body.draft.status).toBe("approved");
    expect(body.event?.kind).toBe("continuity.draft_reviewed");
    const meta = body.event?.meta;
    if (typeof meta !== "object" || meta === null) {
      throw new Error("expected draft reviewed meta object");
    }
    expect((meta as { latency_ms?: unknown }).latency_ms).toEqual(expect.any(Number));
    expect((meta as { latency_ms: number }).latency_ms >= 0).toBe(true);
  } finally {
    h.stop();
  }
});

test("continuity record failure does not block the trigger response and warns once", async () => {
  const { harness: h, repo } = await continuityHarness({
    outputPath: "docs/notes/maestro-continuation-2026-05-01-am.skeleton.md",
    body: "Skeleton body\n",
  });
  const sessionEventLog = h.services.sessionEventLog;
  const originalRecord = sessionEventLog.record.bind(sessionEventLog);
  const warnCalls: unknown[] = [];
  const originalWarn = h.services.log.warn.bind(h.services.log);
  sessionEventLog.record = (event): number => {
    if (event.kind === "continuity.skeleton_generated") {
      throw new Error("simulated continuity record failure");
    }
    return originalRecord(event);
  };
  h.services.log.warn = (obj: unknown, msg?: string): void => {
    warnCalls.push({ obj, msg });
  };
  try {
    await triggerWorkflow(h, repo);

    const events = await listContinuityEvents(h);
    expect(events.filter((event) => event.kind.startsWith("continuity."))).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
  } finally {
    sessionEventLog.record = originalRecord;
    h.services.log.warn = originalWarn;
    h.stop();
  }
});
