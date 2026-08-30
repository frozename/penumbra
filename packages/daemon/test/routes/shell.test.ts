import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@src/serve.js";
import {
  type RunCommandInput,
  type RunCommandResult,
  ShellSessionPool,
} from "@src/services/shell-session-pool.js";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type RuntimeShellConfig = ConstructorParameters<typeof ShellSessionPool>[0]["config"];
type PermissionToolName = "shell_run" | "shell_run.dangerous";

interface PendingPermissionRequest {
  handoff_id: string;
  agent_name: string;
  tool_name: PermissionToolName;
  context: Record<string, unknown>;
  resolve: (value: { approved: boolean }) => void;
}

interface QueuedPermissionDecision {
  handoff_id: string;
  agent_name: string;
  tool_name: PermissionToolName;
  approved: boolean;
}

// File-local typed shape for the daemon-test extensions to Services. The
// shellSessionPool / shellConfig fields are already on the core Services
// interface, agentchatConfig lives on DaemonServices (serve.ts), and
// permissionService is consumed by the shell route via an `as any` cast at
// src/routes/shell.ts:56 — it is not declared on either Services type today.
// This file-local shape captures only the fields these tests exercise.
interface TestPermissionRequestInput {
  parent_handoff_id: string;
  agent_name: string;
  tool_name: PermissionToolName;
  context: Record<string, unknown>;
}
interface TestPermissionService {
  requestPermission(input: TestPermissionRequestInput): Promise<{ approved: boolean }>;
}
interface TestAgentchatAgent {
  name: string;
  auto_approve_to: string[];
}
interface TestAgentchatConfig {
  agents: TestAgentchatAgent[];
}
type TestServices = Services & {
  shellSessionPool?: ShellSessionPool;
  shellConfig?: RuntimeShellConfig | Record<string, never>;
  agentchatConfig?: TestAgentchatConfig;
  permissionService?: TestPermissionService;
};

// Single documented gap: the daemon's runtime services exposes shellConfig as a
// ShellSessionPoolLike and treats `permissionService` as untyped at the call
// site (src/routes/shell.ts:56). The cast here lets the test mutate those
// fields with concrete types in one place rather than at every assignment.
function asTestServices(svc: Services): TestServices {
  return svc as unknown as TestServices;
}

// Response shapes the shell routes emit; tests only inspect these fields.
interface ShellRunOk {
  session_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
interface ShellCloseOk {
  closed: boolean;
}
interface ShellListOk {
  sessions: { session_id: string }[];
}
interface ShellErrorBody {
  error: { code: string; message?: string };
}

async function readJsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ShellOpenEventMeta {
  session_id: string;
  cwd: string | null;
  pty: boolean;
}

function makeShellConfig(
  maxSessionsPerHandoff = 4,
  baseDangerous = ["sudo\\b"],
): RuntimeShellConfig {
  return {
    enabled: true,
    maxSessionsPerHandoff,
    maxConcurrentRunsPerSession: 1,
    maxSessionIdleMs: 600000,
    maxCommandDurationMs: 5000,
    outputByteLimit: 16384,
    redactOutput: true,
    unsetEnv: [],
    dangerousCommands: baseDangerous,
    dangerousCommandsForAgent: () => baseDangerous,
    redactOutputForAgent: () => true,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const pools: ShellSessionPool[] = [];

afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.shutdown()));
  pools.length = 0;
});

interface StartTestDaemonOpts {
  shellEnabled: boolean;
  shellConfigLoaded?: boolean;
  shellConfigMalformed?: boolean;
  shellDangerousPatterns?: string[];
  shellMaxSessions?: number;
  requireShellPermission?: boolean;
  handoffs?: { handoff_id: string; to_agent: string; status?: string }[];
  worktreePathByHandoff?: Record<string, string>;
}

interface PermissionTarget {
  handoff_id: string;
  agent_name: string;
  tool_name: PermissionToolName;
}

interface TestDaemonHandle {
  url: string;
  services: Services;
  token: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  approvePermission: (input: PermissionTarget) => void;
  rejectPermission: (input: PermissionTarget) => void;
  countPermissionRequests: (toolName?: PermissionToolName) => number;
}

function startTestDaemon(opts: StartTestDaemonOpts): TestDaemonHandle {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/shell-routes-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  const token = "tok";
  const permissionRequests: PendingPermissionRequest[] = [];
  const seenPermissionRequests: Pick<
    PendingPermissionRequest,
    "handoff_id" | "agent_name" | "tool_name"
  >[] = [];
  const queuedPermissionDecisions: QueuedPermissionDecision[] = [];
  const sessionPrefix = Math.random().toString(36).slice(2, 10);
  const pool = opts.shellEnabled
    ? new ShellSessionPool({
        config: makeShellConfig(opts.shellMaxSessions ?? 4, opts.shellDangerousPatterns),
        uuid: (() => {
          let i = 0;
          return (): string => `${sessionPrefix}-sess-${String(++i)}`;
        })(),
      })
    : undefined;
  if (pool) {
    pools.push(pool);
  }
  const originalRunCommand = pool?.runCommand.bind(pool);
  if (pool && originalRunCommand) {
    pool.runCommand = async (input: RunCommandInput): Promise<RunCommandResult> => {
      if (input.command === "sudo rm -rf /") {
        return {
          exit_code: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        };
      }
      return await originalRunCommand(input);
    };
  }
  const testServices = asTestServices(services);
  testServices.shellSessionPool = pool;
  if (opts.shellConfigMalformed) {
    testServices.shellConfig = {};
  } else if (opts.shellConfigLoaded !== false) {
    testServices.shellConfig = makeShellConfig(
      opts.shellMaxSessions ?? 4,
      opts.shellDangerousPatterns,
    );
  }
  testServices.agentchatConfig = {
    agents: [
      { name: "a", auto_approve_to: opts.requireShellPermission ? [] : ["shell_run"] },
      {
        name: "claude-acp-sonnet",
        auto_approve_to: opts.requireShellPermission ? [] : ["shell_run"],
      },
    ],
  };
  testServices.permissionService = {
    requestPermission: (input: TestPermissionRequestInput): Promise<{ approved: boolean }> =>
      new Promise<{ approved: boolean }>((resolve) => {
        seenPermissionRequests.push({
          handoff_id: input.parent_handoff_id,
          agent_name: input.agent_name,
          tool_name: input.tool_name,
        });
        const queuedDecisionIdx = queuedPermissionDecisions.findIndex(
          (decision) =>
            decision.handoff_id === input.parent_handoff_id &&
            decision.agent_name === input.agent_name &&
            decision.tool_name === input.tool_name,
        );
        if (queuedDecisionIdx >= 0) {
          const [decision] = queuedPermissionDecisions.splice(queuedDecisionIdx, 1);
          resolve({ approved: decision!.approved });
          return;
        }
        permissionRequests.push({
          handoff_id: input.parent_handoff_id,
          agent_name: input.agent_name,
          tool_name: input.tool_name,
          context: input.context,
          resolve,
        });
      }),
  };
  const handler = createDaemonFetchHandler({ services, token });
  function resolvePermission(input: PermissionTarget, approved: boolean): void {
    const idx = permissionRequests.findIndex(
      (req) =>
        req.handoff_id === input.handoff_id &&
        req.agent_name === input.agent_name &&
        req.tool_name === input.tool_name,
    );
    if (idx >= 0) {
      const [request] = permissionRequests.splice(idx, 1);
      request!.resolve({ approved });
      return;
    }
    queuedPermissionDecisions.push({ ...input, approved });
  }
  for (const h of opts.handoffs ?? []) {
    db.prepare(
      `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
       VALUES (?, '2026-05-20T00:00:00Z', 'conv-test', 'maestro', ?, 'task', ?)`,
    ).run(h.handoff_id, h.to_agent, h.status ?? "dispatched");
  }
  const worktreeOverride = opts.worktreePathByHandoff;
  if (worktreeOverride !== undefined) {
    (services as unknown as { worktreeManager: unknown }).worktreeManager = {
      getWorktree: (handoffId: string): { path: string } | null => {
        const p = worktreeOverride[handoffId];
        return p ? { path: p } : null;
      },
    };
  } else {
    // Default: hand every handoff a worktree at process.cwd() so tests that don't
    // care about cwd resolution still satisfy the fail-closed no_worktree guard
    // in shellRunRoute. Tests that want to exercise the null path pass {} explicitly.
    (services as unknown as { worktreeManager: unknown }).worktreeManager = {
      getWorktree: (): { path: string } | null => ({ path: process.cwd() }),
    };
  }
  return {
    url: "http://x",
    services,
    token,
    fetch: (input, init) => handler(new Request(input, init)),
    approvePermission: (input): void => {
      resolvePermission(input, true);
    },
    rejectPermission: (input): void => {
      resolvePermission(input, false);
    },
    countPermissionRequests: (toolName) =>
      toolName
        ? seenPermissionRequests.filter((req) => req.tool_name === toolName).length
        : seenPermissionRequests.length,
  };
}

describe("shell routes", () => {
  it("POST /shell/run creates a session, runs the command, and returns shape", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "claude-acp-sonnet" }],
    });
    const post = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        handoff_id: "h-1",
        agent_name: "claude-acp-sonnet",
        command: "echo hi",
      }),
    });
    expect(post.status).toBe(200);
    const json = await readJsonAs<ShellRunOk>(post);
    expect(json.session_id).toBeTruthy();
    expect(json.exit_code).toBe(0);
    expect(json.stdout).toBe("hi\n");
  });

  it("POST /shell/run with explicit session_id reuses the session", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const first = await readJsonAs<ShellRunOk>(
      await fetch(`${url}/shell/run`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "cd /tmp" }),
      }),
    );
    const second = await readJsonAs<ShellRunOk>(
      await fetch(`${url}/shell/run`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          handoff_id: "h-1",
          agent_name: "a",
          session_id: first.session_id,
          command: "pwd",
        }),
      }),
    );
    expect(second.stdout.trim()).toBe("/tmp");
    expect(second.session_id).toBe(first.session_id);
  });

  it("POST /shell/close closes a session and subsequent run returns exit_code -1", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const opened = await readJsonAs<ShellRunOk>(
      await fetch(`${url}/shell/run`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
      }),
    );
    const closed = await readJsonAs<ShellCloseOk>(
      await fetch(`${url}/shell/close`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ handoff_id: "h-1", session_id: opened.session_id }),
      }),
    );
    expect(closed.closed).toBe(true);

    const post = await readJsonAs<ShellRunOk>(
      await fetch(`${url}/shell/run`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          handoff_id: "h-1",
          agent_name: "a",
          session_id: opened.session_id,
          command: "echo hi",
        }),
      }),
    );
    expect(post.exit_code).toBe(-1);
  });

  it("emits shell.session.open + shell.run + shell.session.close dispatch events", async () => {
    const { url, token, fetch, services, approvePermission } = startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const first = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(() => {
      approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" });
    }, 50);
    const opened = await readJsonAs<ShellRunOk>(await first);
    await fetch(`${url}/shell/close`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", session_id: opened.session_id }),
    });

    const events = services.dispatchEventLog.listByHandoff("h-1");
    expect(events.map((e) => e.kind)).toEqual([
      "shell.session.open",
      "shell.run",
      "shell.session.close",
    ]);
    const openMeta = JSON.parse(events[0]!.meta_json!) as ShellOpenEventMeta;
    expect(openMeta.session_id).toBe(opened.session_id);
  });

  it("GET /shell/list returns sessions for a handoff", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    const list = await readJsonAs<ShellListOk>(
      await fetch(`${url}/shell/list?handoff_id=h-1`, {
        headers: authHeaders(token),
      }),
    );
    expect(list.sessions).toHaveLength(1);
  });

  it("POST /shell/run returns 429 past max_sessions_per_handoff", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      shellMaxSessions: 1,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    const second = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo two" }),
    });
    expect(second.status).toBe(429);
  });

  it("POST /shell/run returns 503 when shell is disabled", async () => {
    const { url, token, fetch } = startTestDaemon({ shellEnabled: false });
    const post = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    expect(post.status).toBe(503);
  });

  it("POST /shell/run returns 503 shell_config_unavailable when shellConfig is absent", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      shellConfigLoaded: false,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const post = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo safe" }),
    });
    expect(post.status).toBe(503);
    const body = await readJsonAs<ShellErrorBody>(post);
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });

  it("POST /shell/run rejects a cwd that resolves outside the handoff worktree", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "shell-cwd-wt-"));
    try {
      const { url, token, fetch } = startTestDaemon({
        shellEnabled: true,
        handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
        worktreePathByHandoff: { "h-1": wt },
      });
      const outside = os.tmpdir();
      const post = await fetch(`${url}/shell/run`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          handoff_id: "h-1",
          agent_name: "a",
          cwd: outside,
          command: "pwd",
        }),
      });
      expect(post.status).toBe(400);
      const body = await readJsonAs<ShellErrorBody>(post);
      expect(body.error.code).toBe("cwd_outside_worktree");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("POST /shell/run returns 400 no_worktree when no worktree is registered and no cwd is provided", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
      worktreePathByHandoff: {}, // installs a worktreeManager whose getWorktree returns null
    });
    const post = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        handoff_id: "h-1",
        agent_name: "a",
        command: "pwd",
      }),
    });
    expect(post.status).toBe(400);
    const body = await readJsonAs<ShellErrorBody>(post);
    expect(body.error.code).toBe("no_worktree");
  });

  it("POST /shell/run accepts a cwd inside the handoff worktree", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "shell-cwd-wt-"));
    try {
      const sub = path.join(wt, "sub");
      fs.mkdirSync(sub);
      const { url, token, fetch } = startTestDaemon({
        shellEnabled: true,
        handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
        worktreePathByHandoff: { "h-1": wt },
      });
      const post = await fetch(`${url}/shell/run`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          handoff_id: "h-1",
          agent_name: "a",
          cwd: sub,
          command: "pwd",
        }),
      });
      expect(post.status).toBe(200);
      const json = await readJsonAs<ShellRunOk>(post);
      expect(json.exit_code).toBe(0);
      expect(fs.realpathSync(json.stdout.trim())).toBe(fs.realpathSync(sub));
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("POST /shell/run returns 503 shell_config_unavailable when shellConfig is truthy but malformed", async () => {
    const { url, token, fetch } = startTestDaemon({
      shellEnabled: true,
      shellConfigMalformed: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const post = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo safe" }),
    });
    expect(post.status).toBe(503);
    const body = await readJsonAs<ShellErrorBody>(post);
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });
});

describe("shell routes — permission gating", () => {
  it("treats malformed regex pattern as a match (fail closed) and routes to dangerous gate", async () => {
    const { url, token, fetch, countPermissionRequests, rejectPermission } = startTestDaemon({
      shellEnabled: true,
      requireShellPermission: false, // normally shell_run is auto-approved
      shellDangerousPatterns: ["[", "sudo\\b"], // Malformed regex
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });

    // Queue rejection for the dangerous command permission request
    rejectPermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run.dangerous" });

    // This command is safe, but the malformed regex fails closed, triggering dangerous gate
    const danger = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        handoff_id: "h-1",
        agent_name: "a",
        command: "echo safe",
      }),
    });

    const json = await readJsonAs<ShellRunOk>(await danger);
    expect(json.exit_code).toBe(-2);
    expect(json.stderr).toContain("permission denied");

    // It should request "shell_run.dangerous" permission
    expect(countPermissionRequests("shell_run.dangerous")).toBe(1);
  });

  it("first shell_run for a session triggers a permission request and waits for approval", async () => {
    const { url, token, fetch, approvePermission } = startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const runPromise = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(() => {
      approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" });
    }, 50);
    const resp = await runPromise;
    expect(resp.status).toBe(200);
    const json = await readJsonAs<ShellRunOk>(resp);
    expect(json.exit_code).toBe(0);
  });

  it("second shell_run on an approved session skips the permission prompt", async () => {
    const { url, token, fetch, approvePermission, countPermissionRequests } = startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const first = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "cd /tmp" }),
    });
    setTimeout(() => {
      approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" });
    }, 50);
    const firstResp = await first;
    const sid = (await readJsonAs<ShellRunOk>(firstResp)).session_id;
    const beforeCount = countPermissionRequests();
    const second = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", session_id: sid, command: "pwd" }),
    });
    expect(second.status).toBe(200);
    expect(countPermissionRequests()).toBe(beforeCount);
  });

  it("rejected first run drops the session and returns exit_code -2", async () => {
    const { url, token, fetch, rejectPermission } = startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const runPromise = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(() => {
      rejectPermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" });
    }, 50);
    const json = await readJsonAs<ShellRunOk>(await runPromise);
    expect(json.exit_code).toBe(-2);
    expect(json.stderr).toContain("permission denied");
  });

  it("dangerous command on an approved session re-prompts with shell_run.dangerous", async () => {
    const { url, token, fetch, approvePermission, countPermissionRequests } = startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const first = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(() => {
      approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" });
    }, 50);
    const sid = (await readJsonAs<ShellRunOk>(await first)).session_id;
    const danger = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        handoff_id: "h-1",
        agent_name: "a",
        session_id: sid,
        command: "sudo rm -rf /",
      }),
    });
    setTimeout(() => {
      approvePermission({
        handoff_id: "h-1",
        agent_name: "a",
        tool_name: "shell_run.dangerous",
      });
    }, 50);
    const json = await readJsonAs<ShellRunOk>(await danger);
    expect(json.session_id).toBe(sid);
    expect(countPermissionRequests("shell_run.dangerous")).toBe(1);
  });
});
