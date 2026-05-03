import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices, loadSqliteVec, type Services } from '@penumbra/core';
import { createDaemonFetchHandler } from '../../src/serve.js';
import { ShellSessionPool } from '../../src/services/shell-session-pool.js';

type RuntimeShellConfig = ConstructorParameters<typeof ShellSessionPool>[0]['config'];

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

async function startTestDaemon(opts: { shellEnabled: boolean; shellMaxSessions?: number }): Promise<{
  url: string;
  services: Services;
  token: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
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
  const pool = opts.shellEnabled
    ? new ShellSessionPool({
      config: makeShellConfig(opts.shellMaxSessions ?? 4),
      uuid: (() => {
        let i = 0;
        return () => `sess-${++i}`;
      })(),
    })
    : undefined;
  if (pool) {
    pools.push(pool);
  }
  (services as any).shellSessionPool = pool;
  const handler = createDaemonFetchHandler({ services, token });
  return {
    url: 'http://x',
    services,
    token,
    fetch: (input, init) => handler(new Request(input, init)),
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
