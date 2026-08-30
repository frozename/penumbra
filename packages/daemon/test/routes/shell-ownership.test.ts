import {
  applySchema,
  buildServices,
  loadSqliteVec,
  type Services,
  WorkerTokenStore,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@src/serve.js";
import { ShellSessionPool } from "@src/services/shell-session-pool.js";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";

process.env["PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID"] = "";

type RuntimeShellConfig = ConstructorParameters<typeof ShellSessionPool>[0]["config"];

function makeShellConfig(): RuntimeShellConfig {
  return {
    enabled: true,
    maxSessionsPerHandoff: 4,
    maxConcurrentRunsPerSession: 1,
    maxSessionIdleMs: 600000,
    maxCommandDurationMs: 5000,
    outputByteLimit: 16384,
    redactOutput: true,
    unsetEnv: [],
    dangerousCommands: [],
    dangerousCommandsForAgent: () => [],
    redactOutputForAgent: () => true,
  };
}

function insertHandoffWithWorker(
  db: Database,
  opts: { handoff_id: string; to_agent: string; status: string; worker_id: string | null },
): void {
  db.prepare(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, worker_id)
     VALUES (?, '2026-05-20T00:00:00Z', 'conv-ownership', 'maestro', ?, 'task', ?, ?)`,
  ).run(opts.handoff_id, opts.to_agent, opts.status, opts.worker_id);
}

function issueWorkerToken(db: Database, worker_id: string): string {
  const store = new WorkerTokenStore(db);
  const { token } = store.issue({ worker_id }, Date.now());
  return token;
}

const pools: ShellSessionPool[] = [];

afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.shutdown()));
  pools.length = 0;
});

interface Setup {
  db: Database;
  services: Services;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  commandsRun: string[];
}

interface ErrorResponseBody {
  error: { code: string };
}

interface ShellRunResponseBody {
  exit_code: number;
}

type ShellRouteServices = Services & {
  agentchatConfig: {
    agents: { name: string; roles: string[]; auto_approve_to: string[] }[];
  };
};

function makeSetup(): Setup {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/shell-ownership-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  const commandsRun: string[] = [];
  const pool = new ShellSessionPool({
    config: makeShellConfig(),
    uuid: (() => {
      let i = 0;
      return (): string => {
        i += 1;
        return `sess-${String(i)}`;
      };
    })(),
  });
  pools.push(pool);
  const originalRun = pool.runCommand.bind(pool);
  pool.runCommand = (input): ReturnType<ShellSessionPool["runCommand"]> => {
    commandsRun.push(input.command);
    return originalRun(input);
  };

  services.shellSessionPool = pool;
  services.shellConfig = makeShellConfig();
  // Hand every handoff a worktree at process.cwd() so the shell route's
  // no_worktree fail-closed guard does not trip in tests that don't supply a cwd.
  (services as unknown as { worktreeManager: unknown }).worktreeManager = {
    getWorktree: (): { path: string } | null => ({ path: process.cwd() }),
  };
  const shellServices = services as ShellRouteServices;
  shellServices.agentchatConfig = {
    agents: [{ name: "claude-acp-sonnet", roles: [], auto_approve_to: ["shell_run"] }],
  };

  const handler = createDaemonFetchHandler({ services, token: "shared-tok" });
  return {
    db,
    services,
    commandsRun,
    fetch: (input, init): Promise<Response> => handler(new Request(input, init)),
  };
}

const BASE = "http://x";

describe("shell routes — worker ownership enforcement", () => {
  it("/shell/run returns 403 ownership_mismatch when worker-B targets worker-A's handoff", async () => {
    const { db, fetch, commandsRun } = makeSetup();
    insertHandoffWithWorker(db, {
      handoff_id: "h-own-1",
      to_agent: "claude-acp-sonnet",
      status: "dispatched",
      worker_id: "worker-A",
    });
    const tokenB = issueWorkerToken(db, "worker-B");

    const res = await fetch(`${BASE}/shell/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({
        handoff_id: "h-own-1",
        agent_name: "claude-acp-sonnet",
        command: "echo pwned",
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("ownership_mismatch");
    expect(commandsRun).toHaveLength(0);
  });

  it("/shell/run allows worker-A on its own handoff", async () => {
    const { db, fetch, commandsRun } = makeSetup();
    insertHandoffWithWorker(db, {
      handoff_id: "h-own-2",
      to_agent: "claude-acp-sonnet",
      status: "dispatched",
      worker_id: "worker-A",
    });
    const tokenA = issueWorkerToken(db, "worker-A");

    const res = await fetch(`${BASE}/shell/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        handoff_id: "h-own-2",
        agent_name: "claude-acp-sonnet",
        command: "echo ok",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ShellRunResponseBody;
    expect(body.exit_code).toBe(0);
    expect(commandsRun).toHaveLength(1);
  });

  it("/shell/run allows shared (maestro/CLI) principal on a worker-owned handoff", async () => {
    const { db, fetch, commandsRun } = makeSetup();
    insertHandoffWithWorker(db, {
      handoff_id: "h-own-3",
      to_agent: "claude-acp-sonnet",
      status: "dispatched",
      worker_id: "worker-A",
    });

    const res = await fetch(`${BASE}/shell/run`, {
      method: "POST",
      headers: { authorization: "Bearer shared-tok" },
      body: JSON.stringify({
        handoff_id: "h-own-3",
        agent_name: "claude-acp-sonnet",
        command: "echo shared",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ShellRunResponseBody;
    expect(body.exit_code).toBe(0);
    expect(commandsRun).toHaveLength(1);
  });

  it("/shell/close returns 403 ownership_mismatch when worker-B targets worker-A's handoff", async () => {
    const { db, fetch } = makeSetup();
    insertHandoffWithWorker(db, {
      handoff_id: "h-own-close",
      to_agent: "claude-acp-sonnet",
      status: "dispatched",
      worker_id: "worker-A",
    });
    const tokenB = issueWorkerToken(db, "worker-B");

    const res = await fetch(`${BASE}/shell/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ handoff_id: "h-own-close", session_id: "sess-1" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("/shell/list returns 403 ownership_mismatch when worker-B targets worker-A's handoff", async () => {
    const { db, fetch } = makeSetup();
    insertHandoffWithWorker(db, {
      handoff_id: "h-own-list",
      to_agent: "claude-acp-sonnet",
      status: "dispatched",
      worker_id: "worker-A",
    });
    const tokenB = issueWorkerToken(db, "worker-B");

    const res = await fetch(`${BASE}/shell/list?handoff_id=h-own-list`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error.code).toBe("ownership_mismatch");
  });
});
