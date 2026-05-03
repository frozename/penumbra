import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices, loadSqliteVec, type Services } from '@penumbra/core';
import { createDaemonFetchHandler } from '../../src/serve.js';
import { ShellSessionPool } from '../../src/services/shell-session-pool.js';

type RuntimeShellConfig = ConstructorParameters<typeof ShellSessionPool>[0]['config'];
type PermissionToolName = 'shell_run' | 'shell_run.dangerous';

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

function makeShellConfig(maxSessionsPerHandoff = 4): RuntimeShellConfig {
  const baseDangerous = ['sudo\\b'];
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
  shellMaxSessions?: number;
  requireShellPermission?: boolean;
}): Promise<{
  url: string;
  services: Services;
  token: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  approvePermission: (input: { handoff_id: string; agent_name: string; tool_name: PermissionToolName }) => void;
  rejectPermission: (input: { handoff_id: string; agent_name: string; tool_name: PermissionToolName }) => void;
  countPermissionRequests: (toolName?: PermissionToolName) => number;
}> {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/shell-routes-test',
    db,
    embedder: null as any,
  });
  const token = 'tok';
  const permissionRequests: PendingPermissionRequest[] = [];
  const seenPermissionRequests: Array<Pick<PendingPermissionRequest, 'handoff_id' | 'agent_name' | 'tool_name'>> = [];
  const queuedPermissionDecisions: QueuedPermissionDecision[] = [];
  const sessionPrefix = Math.random().toString(36).slice(2, 10);
  const pool = opts.shellEnabled
    ? new ShellSessionPool({
      config: makeShellConfig(opts.shellMaxSessions ?? 4),
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
      if (input.command === 'sudo rm -rf /') {
        return {
          exit_code: 0,
          stdout: '',
          stderr: '',
          truncated: false,
        };
      }
      return originalRunCommand(input);
    };
  }
  (services as any).shellSessionPool = pool;
  (services as any).shellConfig = makeShellConfig(opts.shellMaxSessions ?? 4);
  (services as any).agentchatConfig = {
    agents: [
      { name: 'a', auto_approve_to: opts.requireShellPermission ? [] : ['shell_run'] },
      { name: 'claude-acp-sonnet', auto_approve_to: opts.requireShellPermission ? [] : ['shell_run'] },
    ],
  };
  (services as any).permissionService = {
    requestPermission: (input: {
      parent_handoff_id: string;
      agent_name: string;
      tool_name: PermissionToolName;
      context: Record<string, unknown>;
    }) => new Promise<{ approved: boolean }>((resolve) => {
      seenPermissionRequests.push({
        handoff_id: input.parent_handoff_id,
        agent_name: input.agent_name,
        tool_name: input.tool_name,
      });
      const queuedDecisionIdx = queuedPermissionDecisions.findIndex((decision) => (
        decision.handoff_id === input.parent_handoff_id
        && decision.agent_name === input.agent_name
        && decision.tool_name === input.tool_name
      ));
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
    const idx = permissionRequests.findIndex((req) => (
      req.handoff_id === input.handoff_id
      && req.agent_name === input.agent_name
      && req.tool_name === input.tool_name
    ));
    if (idx >= 0) {
      const [request] = permissionRequests.splice(idx, 1);
      request!.resolve({ approved });
      return;
    }
    queuedPermissionDecisions.push({ ...input, approved });
  }
  return {
    url: 'http://x',
    services,
    token,
    fetch: (input, init) => handler(new Request(input, init)),
    approvePermission: (input) => resolvePermission(input, true),
    rejectPermission: (input) => resolvePermission(input, false),
    countPermissionRequests: (toolName) => (
      toolName
        ? seenPermissionRequests.filter((req) => req.tool_name === toolName).length
        : seenPermissionRequests.length
    ),
  };
}

describe('shell routes', () => {
  it('POST /shell/run creates a session, runs the command, and returns shape', async () => {
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: true });
    const post = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });
    expect(post.status).toBe(200);
    const json = await post.json() as any;
    expect(json.session_id).toBeTruthy();
    expect(json.exit_code).toBe(0);
    expect(json.stdout).toBe('hi\n');
  });

  it('POST /shell/run with explicit session_id reuses the session', async () => {
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: true });
    const first = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'cd /tmp' }),
    }).then((r) => r.json()) as any;
    const second = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: first.session_id, command: 'pwd' }),
    }).then((r) => r.json()) as any;
    expect(second.stdout.trim()).toBe('/tmp');
    expect(second.session_id).toBe(first.session_id);
  });

  it('POST /shell/close closes a session and subsequent run returns exit_code -1', async () => {
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: true });
    const opened = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    }).then((r) => r.json()) as any;
    const closed = await fetch(`${url}/shell/close`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', session_id: opened.session_id }),
    }).then((r) => r.json()) as any;
    expect(closed.closed).toBe(true);

    const post = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: opened.session_id, command: 'echo hi' }),
    }).then((r) => r.json()) as any;
    expect(post.exit_code).toBe(-1);
  });

  it('GET /shell/list returns sessions for a handoff', async () => {
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: true });
    await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    const list = await fetch(`${url}/shell/list?handoff_id=h-1`, {
      headers: authHeaders(token),
    }).then((r) => r.json()) as any;
    expect(list.sessions).toHaveLength(1);
  });

  it('POST /shell/run returns 429 past max_sessions_per_handoff', async () => {
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: true, shellMaxSessions: 1 });
    await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    const second = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo two' }),
    });
    expect(second.status).toBe(429);
  });

  it('POST /shell/run returns 503 when shell is disabled', async () => {
    const { url, token, fetch } = await startTestDaemon({ shellEnabled: false });
    const post = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    expect(post.status).toBe(503);
  });
});

describe('shell routes — permission gating', () => {
  it('first shell_run for a session triggers a permission request and waits for approval', async () => {
    const { url, token, fetch, approvePermission } = await startTestDaemon({ shellEnabled: true, requireShellPermission: true });
    const runPromise = fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const resp = await runPromise;
    expect(resp.status).toBe(200);
    const json = await resp.json() as any;
    expect(json.exit_code).toBe(0);
  });

  it('second shell_run on an approved session skips the permission prompt', async () => {
    const { url, token, fetch, approvePermission, countPermissionRequests } = await startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
    });
    const first = fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'cd /tmp' }),
    });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const firstResp = await first;
    const sid = (await firstResp.json() as any).session_id;
    const beforeCount = countPermissionRequests();
    const second = await fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: sid, command: 'pwd' }),
    });
    expect(second.status).toBe(200);
    expect(countPermissionRequests()).toBe(beforeCount);
  });

  it('rejected first run drops the session and returns exit_code -2', async () => {
    const { url, token, fetch, rejectPermission } = await startTestDaemon({ shellEnabled: true, requireShellPermission: true });
    const runPromise = fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    setTimeout(() => rejectPermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const json = await (await runPromise).json() as any;
    expect(json.exit_code).toBe(-2);
    expect(json.stderr).toContain('permission denied');
  });

  it('dangerous command on an approved session re-prompts with shell_run.dangerous', async () => {
    const { url, token, fetch, approvePermission, countPermissionRequests } = await startTestDaemon({
      shellEnabled: true,
      requireShellPermission: true,
    });
    const first = fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', command: 'echo hi' }),
    });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run' }), 50);
    const sid = (await (await first).json() as any).session_id;
    const danger = fetch(`${url}/shell/run`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ handoff_id: 'h-1', agent_name: 'a', session_id: sid, command: 'sudo rm -rf /' }),
    });
    setTimeout(() => approvePermission({ handoff_id: 'h-1', agent_name: 'a', tool_name: 'shell_run.dangerous' }), 50);
    const json = await (await danger).json() as any;
    expect(json.session_id).toBe(sid);
    expect(countPermissionRequests('shell_run.dangerous')).toBe(1);
  });
});
