import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  loadProjectRegistry,
  WorkerTokenStore,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "../../src/serve.js";
import type { GhTaskSyncService } from "../../src/sweepers/gh-task-sync.js";
import type { GhClient } from "../../src/services/gh-client.js";
import { conciseTitle } from "../../src/routes/tasks.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

function startTestDaemon(
  opts: { ghClient?: GhClient; ghTaskSyncService?: GhTaskSyncService; workerToken?: boolean } = {},
): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  workerToken?: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "tasks-route-"));
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-23T12:00:00.000Z"),
    worktreeRootDir,
    mainRepoDir,
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };

  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: [
      { name: "codex", tags: ["typescript"], tier: "oc", cost_cents_per_run: 15 },
      {
        name: "openai-codex-deep-acp",
        tags: ["typescript"],
        tier: "oc",
        cost_cents_per_run: 15,
        maestro_capable: true,
      },
    ],
  };

  const token = "tok";
  let workerToken: string | undefined;
  if (opts.workerToken) {
    workerToken = new WorkerTokenStore(db).issue({ worker_id: "worker-1" }, Date.now()).token;
  }
  const handler = createDaemonFetchHandler({
    services,
    token,
    ghClient: opts.ghClient,
    ghTaskSyncService: opts.ghTaskSyncService,
  });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    workerToken,
    stop: () => {
      try {
        services.supervisor.stopAll();
      } catch {}
      try {
        db.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeProjectRegistry(
  entries: Array<{
    project_id: string;
    root_path: string;
    gh_repo?: string;
    remote?: { kind: "github"; repo: string };
  }>,
) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-route-registry-"));
  const yaml = ["projects:"];
  for (const entry of entries) {
    yaml.push(`  - project_id: ${entry.project_id}`);
    yaml.push(`    root_path: ${entry.root_path}`);
    if (entry.gh_repo) yaml.push(`    gh_repo: ${entry.gh_repo}`);
    if (entry.remote) {
      yaml.push("    remote:");
      yaml.push(`      kind: ${entry.remote.kind}`);
      yaml.push(`      repo: ${entry.remote.repo}`);
    }
  }
  const path = join(dir, "projects.yaml");
  writeFileSync(path, `${yaml.join("\n")}\n`);
  return loadProjectRegistry(path);
}

function insertTaskDraftEvent(
  db: Database,
  input: {
    event_id: string;
    ts: string;
    ingest_ts: string;
    project_id: string | null;
    event_type: "task_draft" | "task_draft_promoted";
    draft_id: string;
    payload: unknown;
  },
) {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, event_type, lane, payload_json)
     VALUES (?, ?, ?, 'mcp', ?, 'u', 'm', ?, 'unknown', ?)`,
    [
      input.event_id,
      input.ts,
      input.ingest_ts,
      input.project_id,
      input.event_type,
      JSON.stringify(input.payload),
    ],
  );
}

test("POST /tasks with gh_create queues github issue creation and returns queued status", async () => {
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 42,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 42,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "build task board route",
      created_by_kind: "human",
      created_by_id: "cli",
      gh_create: {
        repo: "acordeiro/penumbra",
        labels: ["tasks"],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
      gh_issue_url?: string;
      gh_issue_number?: number;
      gh_issue_repo?: string;
    };
    expect(created.gh_create_status).toBe("queued");
    expect(created.gh_create_error).toBeNull();
    expect(created.gh_issue_url).toBeUndefined();
    expect(created.gh_issue_number).toBeUndefined();
    expect(created.gh_issue_repo).toBeUndefined();
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with gh_create resolves repo from project registry when omitted", async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: (_task_id, input) => {
        createCalls.push(input);
      },
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 43,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 43,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  daemon.services.projectRegistry = makeProjectRegistry([
    { project_id: "penumbra", root_path: "/tmp/penumbra", gh_repo: "acordeiro/penumbra" },
  ]);
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-111111111111",
    payload: {
      draft_id: "11111111-1111-4111-8111-111111111111",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "build task board route",
      project_id: "penumbra",
      created_by_kind: "human",
      created_by_id: "cli",
      gh_create: {
        labels: ["tasks"],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
    };
    expect(created.gh_create_status).toBe("queued");
    expect(created.gh_create_error).toBeNull();

    expect(createCalls).toEqual([
      {
        repo: "acordeiro/penumbra",
        title: "build task board route",
        body: "build task board route",
        labels: ["tasks"],
        assignees: undefined,
      },
    ]);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks resolves repo from remote github project registry entries", async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: (_task_id, input) => {
        createCalls.push(input);
      },
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 44,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 44,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  daemon.services.projectRegistry = makeProjectRegistry([
    {
      project_id: "penumbra",
      root_path: "/tmp/penumbra",
      remote: { kind: "github", repo: "acordeiro/penumbra" },
    },
  ]);
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "build task board route",
      project_id: "penumbra",
      created_by_kind: "human",
      created_by_id: "cli",
      gh_create: {
        labels: ["tasks"],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
    };
    expect(created.gh_create_status).toBe("queued");
    expect(created.gh_create_error).toBeNull();
    expect(createCalls).toEqual([
      {
        repo: "acordeiro/penumbra",
        title: "build task board route",
        body: "build task board route",
        labels: ["tasks"],
        assignees: undefined,
      },
    ]);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with refiner-origin draft defaults gh_create labels and resolves repo", async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: (_task_id, input) => {
        createCalls.push(input);
      },
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 45,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 45,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  daemon.services.projectRegistry = makeProjectRegistry([
    { project_id: "penumbra", root_path: "/tmp/penumbra", gh_repo: "acordeiro/penumbra" },
  ]);
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-111111111111",
    payload: {
      draft_id: "11111111-1111-4111-8111-111111111111",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      project_id: "penumbra",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:11111111-1111-4111-8111-111111111111",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
    };
    expect(created.gh_create_status).toBe("queued");
    expect(created.gh_create_error).toBeNull();
    expect(createCalls).toEqual([
      {
        repo: "acordeiro/penumbra",
        title: "refiner task file",
        body: "refiner task file",
        labels: ["task-draft", "refiner-promoted"],
        assignees: undefined,
      },
    ]);
  } finally {
    daemon.stop();
  }
});

test("conciseTitle trims long prompts, preserves short sentences, and never returns empty", () => {
  expect(
    conciseTitle(
      "This is a very long prompt designed to keep going past the target title length so that the helper has to truncate it at a word boundary instead of returning the entire text as the issue title because that would be too long.",
    ),
  ).toMatch(/^.{1,100}…$/);
  expect(conciseTitle("Build the task board route. Keep the API stable. Extra context here.")).toBe(
    "Build the task board route.",
  );
  expect(conciseTitle("Line one\nLine two\nLine three")).toBe("Line one Line two Line three");
  expect(conciseTitle("   \n\t  ")).toBe("task");
});

test("POST /tasks with refiner-origin draft emits task_draft_promoted t0 event", async () => {
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 46,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 46,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: null,
    event_type: "task_draft",
    draft_id: "22222222-2222-4222-8222-222222222222",
    payload: {
      draft_id: "22222222-2222-4222-8222-222222222222",
      prompt: "draft prompt",
      affects_projects: ["a"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:22222222-2222-4222-8222-222222222222",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task_id: string };

    const rows = daemon.services.db
      .query(
        `
      SELECT event_type, payload_json
        FROM t0_events
       WHERE event_type = 'task_draft_promoted'
       ORDER BY ts DESC, event_id DESC
    `,
      )
      .all() as Array<{ event_type: string; payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("task_draft_promoted");
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual({
      draft_id: "22222222-2222-4222-8222-222222222222",
      task_ids: [created.task_id],
    });
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with refiner-origin draft rejects missing drafts and already promoted drafts", async () => {
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 47,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 47,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  try {
    const missing = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:99999999-9999-4999-8999-999999999999",
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "invalid_input",
      details: [{ message: "origin draft not found", path: ["origin"] }],
    });

    const draftId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    insertTaskDraftEvent(daemon.services.db, {
      event_id: "draft-created",
      ts: "2026-04-23T11:59:00.000Z",
      ingest_ts: "2026-04-23T11:59:01.000Z",
      project_id: "p1",
      event_type: "task_draft",
      draft_id: draftId,
      payload: {
        draft_id: draftId,
        prompt: "draft prompt",
        affects_projects: ["p1"],
        evidence: {},
        auto_ok: true,
        filed_by_agent: "task-refiner-primary",
        filed_via: "skill_inline",
        parent_draft_id: null,
      },
    });
    insertTaskDraftEvent(daemon.services.db, {
      event_id: "draft-promoted",
      ts: "2026-04-23T12:00:00.000Z",
      ingest_ts: "2026-04-23T12:00:01.000Z",
      project_id: "p1",
      event_type: "task_draft_promoted",
      draft_id: draftId,
      payload: { draft_id: draftId, task_ids: ["task-existing"] },
    });

    const promoted = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      project_id: "p1",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: `draft:${draftId}`,
    });
    expect(promoted.status).toBe(409);
    expect(await promoted.json()).toEqual({
      task_id: null,
      error: "draft already promoted",
    });
  } finally {
    daemon.stop();
  }
});

test("POST /tasks upgrades trusted auto-approved refiner promotions to orchestrate", async () => {
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 52,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 52,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    draft_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    payload: {
      draft_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      prompt: "draft prompt",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      project_id: "p1",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task_id: string };
    const task = daemon.services.db
      .query(
        `SELECT kind, eligibility, origin
           FROM tasks
          WHERE id = ?`,
      )
      .get(created.task_id) as { kind: string; eligibility: string; origin: string | null };
    expect(task).toMatchObject({
      kind: "orchestrate",
      origin: "draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(JSON.parse(task.eligibility)).toEqual({ allow_agents: ["openai-codex-deep-acp"] });
  } finally {
    daemon.stop();
  }
});

test("POST /tasks keeps untrusted or non-auto-approved refiner promotions as work", async () => {
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 53,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 53,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  const trustedFalseDraftId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const untrustedDraftId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "trusted-false",
    ts: "2026-04-23T11:58:00.000Z",
    ingest_ts: "2026-04-23T11:58:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    draft_id: trustedFalseDraftId,
    payload: {
      draft_id: trustedFalseDraftId,
      prompt: "draft prompt",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: false,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "untrusted-true",
    ts: "2026-04-23T11:57:00.000Z",
    ingest_ts: "2026-04-23T11:57:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    draft_id: untrustedDraftId,
    payload: {
      draft_id: untrustedDraftId,
      prompt: "draft prompt",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "some-worker",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const trustedFalse = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      project_id: "p1",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: `draft:${trustedFalseDraftId}`,
    });
    expect(trustedFalse.status).toBe(201);
    const trustedFalseTaskId = (await trustedFalse.json()).task_id as string;
    const trustedFalseTask = daemon.services.db
      .query(`SELECT kind FROM tasks WHERE id = ?`)
      .get(trustedFalseTaskId) as { kind: string };
    expect(trustedFalseTask).toMatchObject({ kind: "work" });

    const untrusted = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      project_id: "p1",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: `draft:${untrustedDraftId}`,
    });
    expect(untrusted.status).toBe(201);
    const untrustedTaskId = (await untrusted.json()).task_id as string;
    const untrustedTask = daemon.services.db
      .query(`SELECT kind FROM tasks WHERE id = ?`)
      .get(untrustedTaskId) as { kind: string };
    expect(untrustedTask).toMatchObject({ kind: "work" });
  } finally {
    daemon.stop();
  }
});

test("POST /tasks rejects forged draft origins before refiner promotion side effects", async () => {
  const events: unknown[] = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 49,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 49,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-1111111111aa",
    payload: {
      draft_id: "11111111-1111-4111-8111-1111111111aa",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  const originalWrite = daemon.services.t0Writer.write.bind(daemon.services.t0Writer);
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created-2",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-111111111111",
    payload: {
      draft_id: "11111111-1111-4111-8111-111111111111",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  daemon.services.t0Writer.write = ((event) => {
    events.push(event);
    return originalWrite(event);
  }) as typeof daemon.services.t0Writer.write;
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:not-a-uuid",
    });
    expect(create.status).toBe(400);
    const body = (await create.json()) as {
      error: string;
      details: Array<{ message: string; path: string[] }>;
    };
    expect(body.error).toBe("invalid_input");
    expect(body.details).toEqual([
      {
        message: "origin: draft:<uuid> requires a valid UUID suffix",
        path: ["origin"],
      },
    ]);
    expect(events).toHaveLength(0);
    const rows = daemon.services.db
      .query(
        `
      SELECT COUNT(*) AS count
        FROM t0_events
       WHERE event_type = 'task_draft_promoted'
    `,
      )
      .get() as { count: number };
    expect(rows.count).toBe(0);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks rejects dash-only draft origins before promotion side effects", async () => {
  const events: unknown[] = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 49,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 49,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-111111111111",
    payload: {
      draft_id: "11111111-1111-4111-8111-111111111111",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  const originalWrite = daemon.services.t0Writer.write.bind(daemon.services.t0Writer);
  daemon.services.t0Writer.write = ((event) => {
    events.push(event);
    return originalWrite(event);
  }) as typeof daemon.services.t0Writer.write;
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:------------------------------------",
    });
    expect(create.status).toBe(400);
    expect(events).toHaveLength(0);
    const rows = daemon.services.db
      .query(
        `
      SELECT COUNT(*) AS count
        FROM t0_events
       WHERE event_type = 'task_draft_promoted'
    `,
      )
      .get() as { count: number };
    expect(rows.count).toBe(0);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks rejects draft origins with non-hex suffixes before promotion side effects", async () => {
  const events: unknown[] = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 49,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 49,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  const originalWrite = daemon.services.t0Writer.write.bind(daemon.services.t0Writer);
  daemon.services.t0Writer.write = ((event) => {
    events.push(event);
    return originalWrite(event);
  }) as typeof daemon.services.t0Writer.write;
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:11111111-1111-4111-8111-11111111111X",
    });
    expect(create.status).toBe(400);
    expect(events).toHaveLength(0);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks accepts uppercase draft UUIDs and normalizes emitted draft_id", async () => {
  const events: unknown[] = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 50,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 50,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  const originalWrite = daemon.services.t0Writer.write.bind(daemon.services.t0Writer);
  daemon.services.t0Writer.write = ((event) => {
    events.push(event);
    return originalWrite(event);
  }) as typeof daemon.services.t0Writer.write;
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "uc-draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-1111111111aa",
    payload: {
      draft_id: "11111111-1111-4111-8111-1111111111aa",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: false,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:11111111-1111-4111-8111-1111111111AA",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task_id: string };
    const rows = daemon.services.db
      .query(
        `
      SELECT event_type, payload_json
        FROM t0_events
       WHERE event_type = 'task_draft_promoted'
       ORDER BY ts DESC, event_id DESC
    `,
      )
      .all() as Array<{ event_type: string; payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual({
      draft_id: "11111111-1111-4111-8111-1111111111aa",
      task_ids: [created.task_id],
    });
    expect(events).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks keeps refiner promotion behavior for UUID-shaped draft origins", async () => {
  const events: unknown[] = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: () => {},
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 50,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 50,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  daemon.services.projectRegistry = makeProjectRegistry([
    { project_id: "penumbra", root_path: "/tmp/penumbra", gh_repo: "acordeiro/penumbra" },
  ]);
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "11111111-1111-4111-8111-111111111111",
    payload: {
      draft_id: "11111111-1111-4111-8111-111111111111",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  const originalWrite = daemon.services.t0Writer.write.bind(daemon.services.t0Writer);
  daemon.services.t0Writer.write = ((event) => {
    events.push(event);
    return originalWrite(event);
  }) as typeof daemon.services.t0Writer.write;
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file",
      project_id: "penumbra",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:11111111-1111-4111-8111-111111111111",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task_id: string; gh_create_status?: string };
    expect(created.gh_create_status).toBe("queued");

    const rows = daemon.services.db
      .query(
        `
      SELECT event_type, payload_json
        FROM t0_events
       WHERE event_type = 'task_draft_promoted'
       ORDER BY ts DESC, event_id DESC
    `,
      )
      .all() as Array<{ event_type: string; payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual({
      draft_id: "11111111-1111-4111-8111-111111111111",
      task_ids: [created.task_id],
    });
    expect(events).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with human origin or no origin stays unchanged", async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: (_task_id, input) => {
        createCalls.push(input);
      },
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 47,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 47,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  daemon.services.projectRegistry = makeProjectRegistry([
    { project_id: "penumbra", root_path: "/tmp/penumbra", gh_repo: "acordeiro/penumbra" },
  ]);
  try {
    const human = await postJson(daemon, "/tasks", {
      prompt: "human task file",
      project_id: "penumbra",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "human:cli",
      gh_create: {
        labels: ["tasks"],
      },
    });
    expect(human.status).toBe(201);
    const humanBody = (await human.json()) as { task_id: string; gh_create_status?: string };
    expect(humanBody.gh_create_status).toBe("queued");

    const plain = await postJson(daemon, "/tasks", {
      prompt: "plain task file",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    expect(plain.status).toBe(201);
    const plainBody = (await plain.json()) as { task_id: string; gh_create_status?: string };
    expect(plainBody.gh_create_status).toBeUndefined();

    expect(createCalls).toEqual([
      {
        repo: "acordeiro/penumbra",
        title: "human task file",
        body: "human task file",
        labels: ["tasks"],
        assignees: undefined,
      },
    ]);

    const rows = daemon.services.db
      .query(
        `
      SELECT COUNT(*) AS count
        FROM t0_events
       WHERE event_type = 'task_draft_promoted'
    `,
      )
      .get() as { count: number };
    expect(rows.count).toBe(0);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with explicit gh_create keeps caller supplied config for refiner-origin drafts", async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: (_task_id, input) => {
        createCalls.push(input);
      },
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 48,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 48,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  insertTaskDraftEvent(daemon.services.db, {
    event_id: "draft-created",
    ts: "2026-04-23T11:59:00.000Z",
    ingest_ts: "2026-04-23T11:59:01.000Z",
    project_id: "penumbra",
    event_type: "task_draft",
    draft_id: "33333333-3333-4333-8333-333333333333",
    payload: {
      draft_id: "33333333-3333-4333-8333-333333333333",
      prompt: "draft prompt",
      affects_projects: ["penumbra"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "task-refiner-primary",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "refiner task file explicit gh",
      created_by_kind: "human",
      created_by_id: "cli",
      origin: "draft:33333333-3333-4333-8333-333333333333",
      gh_create: {
        repo: "acordeiro/custom",
        labels: ["custom"],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task_id: string; gh_create_status?: string };
    expect(created.gh_create_status).toBe("queued");
    expect(createCalls).toEqual([
      {
        repo: "acordeiro/custom",
        title: "refiner task file explicit gh",
        body: "refiner task file explicit gh",
        labels: ["custom"],
        assignees: undefined,
      },
    ]);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with gh_create and missing repo fails when project registry has no gh_repo", async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghTaskSyncService: {
      enqueueTaskGhCreate: (_task_id, input) => {
        createCalls.push(input);
      },
      enqueueSyncLinkedTask: () => {},
      queueStatusUpdate: () => {},
      syncLinkedTaskNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 44,
        gh_state: "OPEN",
        action: "noop",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      pushStatusNow: async () => ({
        task_id: "task-1",
        repo: "acordeiro/penumbra",
        issue_number: 44,
        gh_state: "OPEN",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-04-23T12:00:00.000Z",
      }),
      syncAllLinkedTasks: async () => [],
    },
  });
  daemon.services.projectRegistry = makeProjectRegistry([
    { project_id: "penumbra", root_path: "/tmp/penumbra" },
  ]);
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "build task board route",
      project_id: "penumbra",
      created_by_kind: "human",
      created_by_id: "cli",
      gh_create: {
        labels: ["tasks"],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
    };
    expect(created.gh_create_status).toBe("failed");
    expect(created.gh_create_error).toContain("gh_create.repo missing");
    expect(createCalls).toEqual([]);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with gh_create remains success even when GH would fail later", async () => {
  const daemon = startTestDaemon({
    ghClient: {
      viewIssue: async () => {
        throw new Error("not used");
      },
      closeIssue: async () => {
        throw new Error("not used");
      },
      reopenIssue: async () => {
        throw new Error("not used");
      },
      commentIssue: async () => {
        throw new Error("not used");
      },
      listComments: async () => [],
      createIssue: async () => {
        throw new Error("gh create failed");
      },
    },
  });
  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "build task board route",
      created_by_kind: "human",
      created_by_id: "cli",
      gh_create: {
        repo: "acordeiro/penumbra",
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
      gh_issue_url?: string;
      gh_issue_number?: number;
      gh_issue_repo?: string;
    };
    expect(typeof created.task_id).toBe("string");
    expect(created.gh_create_status).toBe("queued");
    expect(created.gh_create_error).toBeNull();
    expect(created.gh_issue_url).toBeUndefined();
    expect(created.gh_issue_number).toBeUndefined();
    expect(created.gh_issue_repo).toBeUndefined();

    const get = await daemon.fetch(`/tasks/${created.task_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = (await get.json()) as {
      gh_issue_number: number | null;
      gh_issue_repo: string | null;
      gh_create_status?: string;
      gh_create_error?: string | null;
    };
    expect(task.gh_issue_number).toBeNull();
    expect(task.gh_issue_repo).toBeNull();
    expect(task.gh_create_status).toBe("queued");
    expect(task.gh_create_error).toBeNull();
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/comment-gh posts manual comment for linked task", async () => {
  const comments: string[] = [];
  const daemon = startTestDaemon({
    ghClient: {
      createIssue: async () => ({
        number: 99,
        url: "https://github.com/acordeiro/penumbra/issues/99",
      }),
      viewIssue: async () => ({
        number: 99,
        state: "OPEN",
        stateReason: null,
        updatedAt: "2026-05-08T00:00:00.000Z",
        title: "Issue 99",
        url: "https://github.com/acordeiro/penumbra/issues/99",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async (_repo, _issue, body) => {
        comments.push(body);
        return { comment_url: "https://github.com/acordeiro/penumbra/issues/99#issuecomment-999" };
      },
      listComments: async () => [],
      getAuthenticatedLogin: async () => "penumbra-bot",
    },
  });

  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "manual note test",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    const created = (await create.json()) as { task_id: string };

    const link = await postJson(daemon, `/tasks/${created.task_id}/link-gh`, {
      repo: "acordeiro/penumbra",
      issue_number: 99,
    });
    expect(link.status).toBe(200);

    const comment = await postJson(daemon, `/tasks/${created.task_id}/comment-gh`, {
      body: "please check this edge case",
    });
    expect(comment.status).toBe(200);
    const payload = (await comment.json()) as { comment_url: string };
    expect(payload.comment_url).toContain("issuecomment");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("manual note");
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/comment-gh returns 503 when github client is unavailable", async () => {
  const daemon = startTestDaemon({
    ghClient: {
      createIssue: async () => ({
        number: 101,
        url: "https://github.com/acordeiro/penumbra/issues/101",
      }),
      viewIssue: async () => ({
        number: 101,
        state: "OPEN",
        stateReason: null,
        updatedAt: "2026-05-08T00:00:00.000Z",
        title: "Issue 101",
        url: "https://github.com/acordeiro/penumbra/issues/101",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => {
        throw new Error("github client unavailable");
      },
      listComments: async () => [],
      getAuthenticatedLogin: async () => null,
    },
  });

  try {
    const create = await postJson(daemon, "/tasks", {
      prompt: "manual note unavailable path",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    const created = (await create.json()) as { task_id: string };

    const link = await postJson(daemon, `/tasks/${created.task_id}/link-gh`, {
      repo: "acordeiro/penumbra",
      issue_number: 101,
    });
    expect(link.status).toBe(200);

    const comment = await postJson(daemon, `/tasks/${created.task_id}/comment-gh`, {
      body: "status ping",
    });
    expect(comment.status).toBe(503);
    const payload = (await comment.json()) as { error: string };
    expect(payload.error).toBe("github_client_unavailable");
  } finally {
    daemon.stop();
  }
});

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    ...headers,
  };
}

async function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  return daemon.fetch(path, {
    method: "POST",
    headers: authHeaders(daemon.token, {
      "content-type": "application/json",
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

async function fileTask(
  daemon: ReturnType<typeof startTestDaemon>,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await postJson(daemon, "/tasks", {
    prompt: "implement route",
    created_by_kind: "human",
    created_by_id: "cli",
    ...body,
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { task_id: string };
  return json.task_id;
}

test("POST /tasks returns 201 {task_id} and GET /tasks/:id returns the row", async () => {
  const daemon = startTestDaemon();
  try {
    const create = await postJson(
      daemon,
      "/tasks",
      {
        prompt: "build task board route",
        created_by_kind: "human",
        created_by_id: "cli",
      },
      { "x-penumbra-origin": "http-test" },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task_id: string };

    const get = await daemon.fetch(`/tasks/${created.task_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = (await get.json()) as { id: string; prompt: string; origin: string | null };
    expect(task.id).toBe(created.task_id);
    expect(task.prompt).toBe("build task board route");
    expect(task.origin).toBe("http-test");
  } finally {
    daemon.stop();
  }
});

test("GET /tasks?status=pending lists the filed task", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const res = await daemon.fetch("/tasks?status=pending", {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; status: string }> };
    expect(body.tasks.some((task) => task.id === taskId && task.status === "pending")).toBe(true);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/lease leases a task and GET /tasks/:id?include=lease shows the open lease", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { task_id: string; lease_id: string };
    expect(leased.task_id).toBe(taskId);

    const get = await daemon.fetch(`/tasks/${taskId}?include=lease`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = (await get.json()) as {
      status: string;
      lease: { id: string; agent_id: string } | null;
    };
    expect(task.status).toBe("leased");
    expect(task.lease?.id).toBe(leased.lease_id);
    expect(task.lease?.agent_id).toBe("codex");
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/heartbeat bumps expires_at", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string; expires_at: number };

    daemon.services.clock = () => new Date("2026-04-23T12:00:10.000Z");

    const hb = await postJson(daemon, `/tasks/${taskId}/heartbeat`, {
      lease_id: leased.lease_id,
    });
    expect(hb.status).toBe(200);
    const body = (await hb.json()) as { expires_at: number };
    expect(body.expires_at).toBeGreaterThan(leased.expires_at);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/complete transitions to done when review is not required", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: "implemented",
    });
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as { status: string };
    expect(body.status).toBe("done");

    const get = await daemon.fetch(`/tasks/${taskId}`, {
      headers: authHeaders(daemon.token),
    });
    const task = (await get.json()) as { status: string; result_summary: string | null };
    expect(task.status).toBe("done");
    expect(task.result_summary).toBe("implemented");
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/complete allows shared principal without lease_id but rejects worker-token callers without lease_id", async () => {
  const daemon = startTestDaemon({ workerToken: true });
  try {
    const taskId = await fileTask(daemon);

    const sharedComplete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      result_summary: "landed via shared principal",
    });
    expect(sharedComplete.status).toBe(200);

    const sharedTask = (await (
      await daemon.fetch(`/tasks/${taskId}`, { headers: authHeaders(daemon.token) })
    ).json()) as { status: string; result_summary: string | null };
    expect(sharedTask.status).toBe("done");
    expect(sharedTask.result_summary).toBe("landed via shared principal");

    const workerTaskId = await fileTask(daemon);
    const workerComplete = await postJson(
      daemon,
      `/tasks/${workerTaskId}/complete`,
      {
        result_summary: "should not land",
      },
      { authorization: `Bearer ${daemon.workerToken}` },
    );
    expect(workerComplete.status).toBe(403);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/complete shared without lease_id uses writer side effects for review tasks", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon, { requires_review: true });
    const link = await postJson(daemon, `/tasks/${taskId}/link-gh`, {
      repo: "owner/repo",
      issue_number: 42,
    });
    expect(link.status).toBe(200);
    daemon.services.db.run(`DELETE FROM gh_outbox`);

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      result_summary: "landed via shared principal",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
    });
    expect(complete.status).toBe(200);
    expect(((await complete.json()) as { status: string }).status).toBe("done_pending_review");

    const get = await daemon.fetch(`/tasks/${taskId}?include=descendants,events`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = (await get.json()) as {
      status: string;
      descendants?: { count: number; ids: string[] };
      events?: Array<{ kind: string; actor: string | null; payload: unknown }>;
    };
    expect(task.status).toBe("done_pending_review");
    expect(task.descendants?.count).toBe(1);
    expect(task.descendants?.ids).toHaveLength(1);
    expect(task.events?.some((event) => event.kind === "review_filed")).toBe(true);

    const outbox = daemon.services.db
      .query<{ task_id: string; op: string; payload_json: string }, [string]>(
        `SELECT task_id, op, payload_json
         FROM gh_outbox
         WHERE task_id = ?
         ORDER BY id ASC
         LIMIT 1`,
      )
      .get(taskId);
    expect(outbox?.task_id).toBe(taskId);
    expect(outbox?.op).toBe("gh_push_status");
    const commentOutbox = daemon.services.db
      .query<{ op: string; payload_json: string }, [string]>(
        `SELECT op, payload_json
         FROM gh_outbox
         WHERE task_id = ? AND op = 'gh_post_status_comment'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(taskId);
    expect(commentOutbox).not.toBeNull();
    expect(JSON.parse(commentOutbox!.payload_json)).toEqual({
      from_status: "pending",
      to_status: "done_pending_review",
    });
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/complete shared without lease_id rejects active leased tasks", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      result_summary: "should not steal active lease",
    });
    expect(complete.status).toBe(409);
    const body = (await complete.json()) as {
      error: string;
      message: string;
      active_lease_id: string | null;
    };
    expect(body.error).toBe("LeaseConflict");
    expect(body.message).toContain(taskId);
    expect(body.active_lease_id).toBe(leased.lease_id);

    const task = (await (
      await daemon.fetch(`/tasks/${taskId}`, { headers: authHeaders(daemon.token) })
    ).json()) as { status: string; result_summary: string | null };
    expect(task.status).toBe("leased");
    expect(task.result_summary).toBeNull();
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/complete without Authorization returns 401", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const res = await daemon.fetch(`/tasks/${taskId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result_summary: "unauthorized" }),
    });
    expect(res.status).toBe(401);
  } finally {
    daemon.stop();
  }
});

test("requires_review flow files a child review task visible via descendants include", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon, { requires_review: true });
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: "ready for review",
    });
    expect(complete.status).toBe(200);

    const get = await daemon.fetch(`/tasks/${taskId}?include=descendants`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = (await get.json()) as {
      status: string;
      descendants?: { count: number; ids: string[] };
    };
    expect(task.status).toBe("done_pending_review");
    expect(task.descendants?.count).toBe(1);
    expect(task.descendants?.ids).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/cancel transitions pending task to cancelled", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const cancel = await postJson(daemon, `/tasks/${taskId}/cancel`, {
      reason: "no longer needed",
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { status: string };
    expect(body.status).toBe("cancelled");

    const get = await daemon.fetch(`/tasks/${taskId}`, {
      headers: authHeaders(daemon.token),
    });
    const task = (await get.json()) as { status: string };
    expect(task.status).toBe("cancelled");
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/fail releases lease and transitions to failed", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string };

    const fail = await postJson(daemon, `/tasks/${taskId}/fail`, {
      lease_id: leased.lease_id,
      reason: "tool crashed",
    });
    expect(fail.status).toBe(200);
    const body = (await fail.json()) as { status: string };
    expect(body.status).toBe("failed");

    const get = await daemon.fetch(`/tasks/${taskId}?include=lease`, {
      headers: authHeaders(daemon.token),
    });
    const task = (await get.json()) as { status: string; lease: unknown };
    expect(task.status).toBe("failed");
    expect(task.lease).toBeNull();
  } finally {
    daemon.stop();
  }
});

test("POST /tasks with empty prompt returns 400", async () => {
  const daemon = startTestDaemon();
  try {
    const res = await postJson(daemon, "/tasks", {
      prompt: "",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/cancel on a done task returns 409", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: "done",
    });
    expect(complete.status).toBe(200);

    const cancel = await postJson(daemon, `/tasks/${taskId}/cancel`, { reason: "too late" });
    expect(cancel.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/:id/heartbeat with stale lease returns 409", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(200);
    const leased = (await lease.json()) as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: "done",
    });
    expect(complete.status).toBe(200);

    const hb = await postJson(daemon, `/tasks/${taskId}/heartbeat`, {
      lease_id: leased.lease_id,
    });
    expect(hb.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test("POST /tasks/lease with no tasks returns 204", async () => {
  const daemon = startTestDaemon();
  try {
    const lease = await postJson(daemon, "/tasks/lease", { agent_id: "codex" });
    expect(lease.status).toBe(204);
  } finally {
    daemon.stop();
  }
});
