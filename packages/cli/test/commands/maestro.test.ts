import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchMaestroSubcommand,
  runMaestroList,
  runMaestroSessionGet,
  runMaestroSessionStart,
  runMaestroSessionStartAdhoc,
} from "@src/commands/maestro.js";
import { runTaskNew, runTaskShow } from "@src/commands/task.js";

import { createDaemonFetchHandler } from "../../../daemon/src/serve.js";
import { expectAsyncThrow, parseJson } from "./_helpers.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* sqlite already loaded */
}

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface MaestroDaemonHandle {
  fetch: (path: string | URL, init?: RequestInit) => Promise<Response>;
  stop: () => void;
}
function setupDaemon(): MaestroDaemonHandle {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  root = mkdtempSync(join(tmpdir(), "penumbra-maestro-cli-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-05T12:00:00.000Z"),
  });
  (services as Services & { agentchatConfig?: unknown }).agentchatConfig = {
    agents: [
      { name: "stub-maestro", adapter: "noop", options: {}, maestro_capable: true, roles: [] },
    ],
    default_roles: {},
  };
  const handler = createDaemonFetchHandler({ services, token: "tok" });
  return {
    fetch: (path, init = {}): Promise<Response> => {
      const pathStr = typeof path === "string" ? path : path.toString();
      const existingHeaders = (init.headers ?? {}) as Record<string, string>;
      return handler(
        new Request(`http://x${pathStr}`, {
          ...init,
          headers: {
            authorization: "Bearer tok",
            ...existingHeaders,
          },
        }),
      );
    },
    stop: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        /* already stopped */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function pathToString(path: string | URL): string {
  return typeof path === "string" ? path : path.toString();
}

function bodyToString(body: unknown): string {
  return typeof body === "string" ? body : "";
}

test("task new --kind orchestrate happy path stores orchestrate kind", async () => {
  const daemon = setupDaemon();
  try {
    const created: string[] = [];
    await runTaskNew({
      prompt: "foo",
      kind: "orchestrate",
      allow_agents: ["stub-maestro"],
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => created.push(line),
    });
    expect(created[0]).toMatch(/^task_/);

    const listed: string[] = [];
    await runTaskShow({
      id: created[0]!,
      json: true,
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => listed.push(line),
    });
    const listedTask = parseJson(listed.join("\n")) as { kind: string };
    expect(listedTask.kind).toBe("orchestrate");
  } finally {
    daemon.stop();
  }
});

test("task new --kind orchestrate without --allow-agent fails locally", async () => {
  await expectAsyncThrow(
    runTaskNew({
      prompt: "foo",
      kind: "orchestrate",
      storageRoot: root,
    }),
    "kind=orchestrate requires at least one --allow-agent",
  );
});

test("task show and maestro list render maestro session information", async () => {
  const daemon = setupDaemon();
  try {
    const created: string[] = [];
    await runTaskNew({
      prompt: "foo",
      kind: "orchestrate",
      allow_agents: ["stub-maestro"],
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => created.push(line),
    });
    const taskId = created[0]!;

    const shown: string[] = [];
    await runTaskShow({
      id: taskId,
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (pathToString(path).startsWith("/maestro/sessions/")) {
          return Response.json({
            task_id: taskId,
            agent_id: "stub-maestro",
            chain_handoff_id: "chain-123456",
            started_at: Date.now() - 120_000,
            consumed_wall_clock_ms: 120_000,
            wall_clock_budget_ms: 1_800_000,
            cost_consumed_cents: 20,
            cost_budget_cents: 200,
            sub_dispatches_consumed: 2,
            sub_dispatch_budget: 10,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          });
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => shown.push(line),
    });
    expect(shown.join("\n")).toContain("Maestro session");

    const table: string[] = [];
    await runMaestroList({
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (pathToString(path).startsWith("/maestro/sessions/")) {
          return Response.json({
            task_id: taskId,
            agent_id: "stub-maestro",
            chain_handoff_id: "chain-123456",
            started_at: Date.now() - 120_000,
            consumed_wall_clock_ms: 120_000,
            wall_clock_budget_ms: 1_800_000,
            cost_consumed_cents: 20,
            cost_budget_cents: 200,
            sub_dispatches_consumed: 2,
            sub_dispatch_budget: 10,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          });
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => table.push(line),
    });
    expect(table.join("\n")).toContain("wall_clock_pct");
    expect(table.join("\n")).toContain(taskId.slice(0, 8));

    const json: string[] = [];
    await runMaestroList({
      json: true,
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => json.push(line),
    });
    expect(() => parseJson(json.join("\n"))).not.toThrow();
  } finally {
    daemon.stop();
  }
});

test("task show renders maestro session budgets from canonical fields", async () => {
  const daemon = setupDaemon();
  try {
    const taskId = "task-render";
    const completed: string[] = [];
    await runTaskShow({
      id: taskId,
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (pathToString(path).startsWith("/tasks/task-render?")) {
          return Response.json({
            id: taskId,
            created_at: Date.now() - 240_000,
            updated_at: Date.now() - 120_000,
            created_by_kind: "human",
            created_by_id: "cli",
            parent_task_id: null,
            kind: "orchestrate",
            priority: "normal",
            prompt: "render maestro",
            acceptance_criteria: null,
            expected_artifacts: null,
            eligibility: {},
            review_eligibility: null,
            requires_review: false,
            status: "running",
            result_summary: null,
            result_artifacts: null,
            failure_reason: null,
            chain_id: null,
            origin: "cli",
            lease: null,
            events: [],
          });
        }
        if (pathToString(path).startsWith("/maestro/sessions/")) {
          return Response.json({
            task_id: taskId,
            agent_id: "stub-maestro",
            chain_handoff_id: "chain-123456",
            started_at: Date.now() - 120_000,
            wall_clock_budget_ms: 1_800_000,
            cost_consumed_cents: 218,
            cost_budget_cents: 200,
            sub_dispatches_consumed: 0,
            sub_dispatch_budget: 4,
            soft_warned_at: null,
            terminated_at: Date.now(),
            termination_reason: "bounds_exceeded:cost",
          });
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => completed.push(line),
    });

    const rendered = completed.join("\n");
    expect(rendered).toContain("$2.18 / $2.00");
    expect(rendered).toContain("terminated:bounds_exceeded:cost");
    expect(rendered).toContain("0 / 4  (0%)");
  } finally {
    daemon.stop();
  }
});

test("task show renders running sessions and null counters without NaN", async () => {
  const daemon = setupDaemon();
  try {
    const taskId = "task-running";
    const output: string[] = [];
    await runTaskShow({
      id: taskId,
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (pathToString(path).startsWith("/tasks/task-running?")) {
          return Response.json({
            id: taskId,
            created_at: Date.now() - 60_000,
            updated_at: Date.now() - 30_000,
            created_by_kind: "human",
            created_by_id: "cli",
            parent_task_id: null,
            kind: "orchestrate",
            priority: "normal",
            prompt: "render running maestro",
            acceptance_criteria: null,
            expected_artifacts: null,
            eligibility: {},
            review_eligibility: null,
            requires_review: false,
            status: "running",
            result_summary: null,
            result_artifacts: null,
            failure_reason: null,
            chain_id: null,
            origin: "cli",
            lease: null,
            events: [],
          });
        }
        if (pathToString(path).startsWith("/maestro/sessions/")) {
          return Response.json({
            task_id: taskId,
            agent_id: "stub-maestro",
            chain_handoff_id: null,
            started_at: Date.now() - 30_000,
            wall_clock_budget_ms: 1_800_000,
            cost_consumed_cents: null,
            cost_budget_cents: 200,
            sub_dispatches_consumed: 2,
            sub_dispatch_budget: 4,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          });
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });

    const rendered = output.join("\n");
    expect(rendered).toContain("$0.00 / $2.00");
    expect(rendered).toContain("running");
    expect(rendered).toContain("2 / 4  (50%)");
    expect(rendered).not.toContain("NaN");
  } finally {
    daemon.stop();
  }
});

test("maestro session start posts to daemon and prints the created session", async () => {
  const daemon = setupDaemon();
  try {
    const output: string[] = [];
    await runMaestroSessionStart({
      json: true,
      storageRoot: root,
      task_id: "task-session-1",
      chain_handoff_id: "handoff-session-1",
      agent: "stub-maestro",
      wall_budget_ms: 90_000,
      cost_budget_cents: 120,
      sub_dispatch_budget: 5,
      fetch: async (path, init) => {
        if (pathToString(path) === "/maestro/sessions") {
          expect(init?.method).toBe("POST");
          const body = parseJson(bodyToString(init?.body));
          expect(body).toEqual({
            task_id: "task-session-1",
            chain_handoff_id: "handoff-session-1",
            agent_id: "stub-maestro",
            wall_clock_budget_ms: 90_000,
            cost_budget_cents: 120,
            sub_dispatch_budget: 5,
          });
          return Response.json(
            {
              task_id: "task-session-1",
              chain_handoff_id: "handoff-session-1",
              agent_id: "stub-maestro",
              started_at: 1_746_000_000_000,
              wall_clock_budget_ms: 90_000,
              cost_budget_cents: 120,
              sub_dispatch_budget: 5,
              cost_consumed_cents: 0,
              sub_dispatches_consumed: 0,
              soft_warned_at: null,
              terminated_at: null,
              termination_reason: null,
            },
            { status: 201 },
          );
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });
    const payload = parseJson(output.join("\n")) as { task_id: string; agent_id: string };
    expect(payload.task_id).toBe("task-session-1");
    expect(payload.agent_id).toBe("stub-maestro");
  } finally {
    daemon.stop();
  }
});

test("maestro session start posts without chain_handoff_id when omitted", async () => {
  const daemon = setupDaemon();
  try {
    const output: string[] = [];
    await runMaestroSessionStart({
      json: true,
      storageRoot: root,
      task_id: "task-session-no-chain",
      agent: "stub-maestro",
      wall_budget_ms: 90_000,
      cost_budget_cents: 120,
      sub_dispatch_budget: 5,
      fetch: async (path, init) => {
        if (pathToString(path) === "/maestro/sessions") {
          expect(init?.method).toBe("POST");
          const body = parseJson(bodyToString(init?.body));
          expect(body).toEqual({
            task_id: "task-session-no-chain",
            agent_id: "stub-maestro",
            wall_clock_budget_ms: 90_000,
            cost_budget_cents: 120,
            sub_dispatch_budget: 5,
          });
          return Response.json(
            {
              task_id: "task-session-no-chain",
              chain_handoff_id: null,
              agent_id: "stub-maestro",
              started_at: 1_746_000_000_000,
              wall_clock_budget_ms: 90_000,
              cost_budget_cents: 120,
              sub_dispatch_budget: 5,
              cost_consumed_cents: 0,
              sub_dispatches_consumed: 0,
              soft_warned_at: null,
              terminated_at: null,
              termination_reason: null,
            },
            { status: 201 },
          );
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });
    const payload = parseJson(output.join("\n")) as {
      task_id: string;
      chain_handoff_id: string | null;
    };
    expect(payload.task_id).toBe("task-session-no-chain");
    expect(payload.chain_handoff_id).toBeNull();
  } finally {
    daemon.stop();
  }
});

test("maestro session start-adhoc posts to daemon and prints dispatch payload", async () => {
  const daemon = setupDaemon();
  try {
    const output: string[] = [];
    await runMaestroSessionStartAdhoc({
      json: true,
      storageRoot: root,
      message: "summarize recent git log",
      agent: "stub-maestro",
      wall_budget_ms: 600_000,
      cost_budget_cents: 50,
      sub_dispatch_budget: 5,
      project_id: "proj-a",
      fetch: async (path, init) => {
        if (pathToString(path) === "/maestro/sessions/adhoc") {
          expect(init?.method).toBe("POST");
          const body = parseJson(bodyToString(init?.body));
          expect(body).toEqual({
            message: "summarize recent git log",
            agent_id: "stub-maestro",
            wall_clock_budget_ms: 600_000,
            cost_budget_cents: 50,
            sub_dispatch_budget: 5,
            project_id: "proj-a",
          });
          return Response.json(
            {
              status: "dispatched",
              agent_name: "stub-maestro",
              chain_handoff_id: "handoff-adhoc-1",
              conversation_id: "conv-adhoc-1",
              session: {
                task_id: "task-adhoc-1",
                chain_handoff_id: "handoff-adhoc-1",
                agent_id: "stub-maestro",
                started_at: 1_746_000_000_000,
                wall_clock_budget_ms: 600_000,
                cost_budget_cents: 50,
                sub_dispatch_budget: 5,
                cost_consumed_cents: 0,
                sub_dispatches_consumed: 0,
                soft_warned_at: null,
                terminated_at: null,
                termination_reason: null,
              },
            },
            { status: 201 },
          );
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });
    const payload = parseJson(output.join("\n")) as {
      status: string;
      session: { task_id: string };
    };
    expect(payload.status).toBe("dispatched");
    expect(payload.session.task_id).toBe("task-adhoc-1");
  } finally {
    daemon.stop();
  }
});

test("dispatchMaestroSubcommand validates required flags for session start-adhoc", async () => {
  const exitCode = await dispatchMaestroSubcommand(
    [
      "session",
      "start-adhoc",
      "--agent",
      "stub-maestro",
      "--wall-budget-ms",
      "600000",
      "--cost-budget-cents",
      "50",
    ],
    root,
  );
  expect(exitCode).toBe(1);
});

test("maestro session get fetches one session by task id", async () => {
  const daemon = setupDaemon();
  try {
    const output: string[] = [];
    await runMaestroSessionGet({
      json: true,
      storageRoot: root,
      task_id: "task-session-get",
      fetch: async (path, init) => {
        if (pathToString(path) === "/maestro/sessions/task-session-get") {
          return Response.json({
            task_id: "task-session-get",
            chain_handoff_id: "handoff-session-get",
            agent_id: "stub-maestro",
            started_at: 1_746_000_000_001,
            wall_clock_budget_ms: 120_000,
            cost_budget_cents: 150,
            sub_dispatch_budget: 6,
            cost_consumed_cents: 25,
            sub_dispatches_consumed: 1,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          });
        }
        return await daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });
    const payload = parseJson(output.join("\n")) as {
      task_id: string;
      chain_handoff_id: string;
    };
    expect(payload.task_id).toBe("task-session-get");
    expect(payload.chain_handoff_id).toBe("handoff-session-get");
    expect(Object.hasOwn(payload as object, "consumed_cost_cents")).toBe(false);
    expect(Object.hasOwn(payload as object, "consumed_sub_dispatches")).toBe(false);
  } finally {
    daemon.stop();
  }
});
