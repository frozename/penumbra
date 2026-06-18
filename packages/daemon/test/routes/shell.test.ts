import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { ShellSessionPool } from "../../src/services/shell-session-pool.js";

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

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

const pools: ShellSessionPool[] = [];

afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.shutdown()));
  pools.length = 0;
});

async function startTestDaemon(opts: {
  shellEnabled: boolean;
  shellConfigLoaded?: boolean;
  shellConfigMalformed?: boolean;
  shellDangerousPatterns?: string[];
  shellMaxSessions?: number;
  requireShellPermission?: boolean;
  handoffs?: Array<{ handoff_id: string; to_agent: string; status?: string }>;
}): Promise<{
  url: string;
  services: Services;
  token: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  approvePermission: (input: {
    handoff_id: string;
    agent_name: string;
    tool_name: PermissionToolName;
  }) => void;
  rejectPermission: (input: {
    handoff_id: string;
    agent_name: string;
    tool_name: PermissionToolName;
  }) => void;
  countPermissionRequests: (toolName?: PermissionToolName) => number;
}> {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/shell-routes-test",
    db,
    embedder: null as any,
  });
  const token = "tok";
  const permissionRequests: PendingPermissionRequest[] = [];
  const seenPermissionRequests: Array<
    Pick<PendingPermissionRequest, "handoff_id" | "agent_name" | "tool_name">
  > = [];
  const queuedPermissionDecisions: QueuedPermissionDecision[] = [];
  const sessionPrefix = Math.random().toString(36).slice(2, 10);
  const pool = opts.shellEnabled
    ? new ShellSessionPool({
        config: makeShellConfig(opts.shellMaxSessions ?? 4, opts.shellDangerousPatterns),
        uuid: (() => {
          let i = 0;
          return () => `${sessionPrefix}-sess-${++i}`;
        })(),
      })
    : undefined;
  if (pool) {
    pools.push(pool);
  }
  const originalRunCommand = pool?.runCommand.bind(pool);
  if (pool && originalRunCommand) {
    pool.runCommand = async (input) => {
      if (input.command === "sudo rm -rf /") {
        return {
          exit_code: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        };
      }
      return originalRunCommand(input);
    };
  }
  (services as any).shellSessionPool = pool;
  if (opts.shellConfigMalformed) {
    (services as any).shellConfig = {};
  } else if (opts.shellConfigLoaded !== false) {
    (services as any).shellConfig = makeShellConfig(
      opts.shellMaxSessions ?? 4,
      opts.shellDangerousPatterns,
    );
  }
  (services as any).agentchatConfig = {
    agents: [
      { name: "a", auto_approve_to: opts.requireShellPermission ? [] : ["shell_run"] },
      {
        name: "claude-acp-sonnet",
        auto_approve_to: opts.requireShellPermission ? [] : ["shell_run"],
      },
    ],
  };
  (services as any).permissionService = {
    requestPermission: (input: {
      parent_handoff_id: string;
      agent_name: string;
      tool_name: PermissionToolName;
      context: Record<string, unknown>;
    }) =>
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
  function resolvePermission(
    input: { handoff_id: string; agent_name: string; tool_name: PermissionToolName },
    approved: boolean,
  ): void {
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
  return {
    url: "http://x",
    services,
    token,
    fetch: (input, init) => handler(new Request(input, init)),
    approvePermission: (input) => resolvePermission(input, true),
    rejectPermission: (input) => resolvePermission(input, false),
    countPermissionRequests: (toolName) =>
      toolName
        ? seenPermissionRequests.filter((req) => req.tool_name === toolName).length
        : seenPermissionRequests.length,
  };
}

describe("shell routes", () => {
  it("POST /shell/run creates a session, runs the command, and returns shape", async () => {
    const { url, token, fetch } = await startTestDaemon({
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
    const json = (await post.json()) as any;
    expect(json.session_id).toBeTruthy();
    expect(json.exit_code).toBe(0);
    expect(json.stdout).toBe("hi\n");
  });

  it("POST /shell/run with explicit session_id reuses the session", async () => {
    const { url, token, fetch } = await startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const first = (await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "cd /tmp" }),
    }).then((r) => r.json())) as any;
    const second = (await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        handoff_id: "h-1",
        agent_name: "a",
        session_id: first.session_id,
        command: "pwd",
      }),
    }).then((r) => r.json())) as any;
    expect(second.stdout.trim()).toBe("/tmp");
    expect(second.session_id).toBe(first.session_id);
  });

  it("POST /shell/close closes a session and subsequent run returns exit_code -1", async () => {
    const { url, token, fetch } = await startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const opened = (await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    }).then((r) => r.json())) as any;
    const closed = (await fetch(`${url}/shell/close`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", session_id: opened.session_id }),
    }).then((r) => r.json())) as any;
    expect(closed.closed).toBe(true);

    const post = (await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        handoff_id: "h-1",
        agent_name: "a",
        session_id: opened.session_id,
        command: "echo hi",
      }),
    }).then((r) => r.json())) as any;
    expect(post.exit_code).toBe(-1);
  });

  it("emits shell.session.open + shell.run + shell.session.close dispatch events", async () => {
    const { url, token, fetch, services, approvePermission } = await startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const first = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(
      () => approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" }),
      50,
    );
    const opened = (await (await first).json()) as any;
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
    const openMeta = JSON.parse(events[0]!.meta_json!);
    expect(openMeta.session_id).toBe(opened.session_id);
  });

  it("GET /shell/list returns sessions for a handoff", async () => {
    const { url, token, fetch } = await startTestDaemon({
      shellEnabled: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    const list = (await fetch(`${url}/shell/list?handoff_id=h-1`, {
      headers: authHeaders(token),
    }).then((r) => r.json())) as any;
    expect(list.sessions).toHaveLength(1);
  });

  it("POST /shell/run returns 429 past max_sessions_per_handoff", async () => {
    const { url, token, fetch } = await startTestDaemon({
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
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: false });
    const post = await fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    expect(post.status).toBe(503);
  });

  it("POST /shell/run returns 503 shell_config_unavailable when shellConfig is absent", async () => {
    const { url, token, fetch } = await startTestDaemon({
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
    const body = (await post.json()) as any;
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });

  it("POST /shell/run returns 503 shell_config_unavailable when shellConfig is truthy but malformed", async () => {
    const { url, token, fetch } = await startTestDaemon({
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
    const body = (await post.json()) as any;
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });
});

describe("shell routes — permission gating", () => {
  it("treats malformed regex pattern as a match (fail closed) and routes to dangerous gate", async () => {
    const { url, token, fetch, countPermissionRequests, rejectPermission } = await startTestDaemon({
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

    const json = (await (await danger).json()) as any;
    expect(json.exit_code).toBe(-2);
    expect(json.stderr).toContain("permission denied");

    // It should request "shell_run.dangerous" permission
    expect(countPermissionRequests("shell_run.dangerous")).toBe(1);
  });

  it("first shell_run for a session triggers a permission request and waits for approval", async () => {
    const { url, token, fetch, approvePermission } = await startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const runPromise = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(
      () => approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" }),
      50,
    );
    const resp = await runPromise;
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as any;
    expect(json.exit_code).toBe(0);
  });

  it("second shell_run on an approved session skips the permission prompt", async () => {
    const { url, token, fetch, approvePermission, countPermissionRequests } = await startTestDaemon(
      {
        shellEnabled: true,
        requireShellPermission: true,
        handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
      },
    );
    const first = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "cd /tmp" }),
    });
    setTimeout(
      () => approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" }),
      50,
    );
    const firstResp = await first;
    const sid = ((await firstResp.json()) as any).session_id;
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
    const { url, token, fetch, rejectPermission } = await startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
      handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
    });
    const runPromise = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(
      () => rejectPermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" }),
      50,
    );
    const json = (await (await runPromise).json()) as any;
    expect(json.exit_code).toBe(-2);
    expect(json.stderr).toContain("permission denied");
  });

  it("dangerous command on an approved session re-prompts with shell_run.dangerous", async () => {
    const { url, token, fetch, approvePermission, countPermissionRequests } = await startTestDaemon(
      {
        shellEnabled: true,
        requireShellPermission: true,
        handoffs: [{ handoff_id: "h-1", to_agent: "a" }],
      },
    );
    const first = fetch(`${url}/shell/run`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: "h-1", agent_name: "a", command: "echo hi" }),
    });
    setTimeout(
      () => approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run" }),
      50,
    );
    const sid = ((await (await first).json()) as any).session_id;
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
    setTimeout(
      () =>
        approvePermission({ handoff_id: "h-1", agent_name: "a", tool_name: "shell_run.dangerous" }),
      50,
    );
    const json = (await (await danger).json()) as any;
    expect(json.session_id).toBe(sid);
    expect(countPermissionRequests("shell_run.dangerous")).toBe(1);
  });
});
