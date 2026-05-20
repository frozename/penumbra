import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices, loadSqliteVec, type Services } from '@penumbra/core';
import { createDaemonFetchHandler } from '../../src/serve.js';
import { ShellSessionPool } from '../../src/services/shell-session-pool.js';

// Guard against env leak from live shell (see memory: daemon_test_env_leak_project_id)
process.env['PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID'] = '';

type RuntimeShellConfig = ConstructorParameters<typeof ShellSessionPool>[0]['config'];

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

function insertHandoff(db: Database, opts: {
  handoff_id: string;
  to_agent: string;
  status: string;
}): void {
  db.prepare(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES (?, '2026-05-20T00:00:00Z', 'conv-authz', 'maestro', ?, 'task', ?)`,
  ).run(opts.handoff_id, opts.to_agent, opts.status);
}

const pools: ShellSessionPool[] = [];

afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.shutdown()));
  pools.length = 0;
});

async function makeSetup(): Promise<{
  db: Database;
  services: Services;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  commandsRun: string[];
}> {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/shell-authz-test',
    db,
    embedder: null as any,
  });

  const commandsRun: string[] = [];
  const pool = new ShellSessionPool({
    config: makeShellConfig(),
    uuid: (() => { let i = 0; return () => `sess-${++i}`; })(),
  });
  pools.push(pool);

  const originalRun = pool.runCommand.bind(pool);
  pool.runCommand = async (input) => {
    commandsRun.push(input.command);
    return originalRun(input);
  };

  (services as any).shellSessionPool = pool;
  (services as any).shellConfig = makeShellConfig();
  (services as any).agentchatConfig = {
    agents: [{ name: 'claude-acp-sonnet', auto_approve_to: ['shell_run'] }],
  };

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });
  return {
    db,
    services,
    commandsRun,
    fetch: (input, init) => handler(new Request(input, init)),
  };
}

const AUTH = { authorization: 'Bearer tok' };
const BASE = 'http://x';

describe('shell/run — authz gate', () => {
  it('(a) rejects impersonation: claimed agent_name differs from handoff.to_agent', async () => {
    const { db, fetch, commandsRun } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-authz-1', to_agent: 'claude-acp-sonnet', status: 'pending' });

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-authz-1', agent_name: 'attacker-agent', command: 'echo pwned' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('agent_mismatch');
    expect(commandsRun).toHaveLength(0);
  });

  it('(b) rejects shell run against a completed handoff', async () => {
    const { db, fetch, commandsRun } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-authz-completed', to_agent: 'claude-acp-sonnet', status: 'completed' });

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-authz-completed', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_terminal');
    expect(commandsRun).toHaveLength(0);
  });

  it('(b) rejects shell run against a failed handoff', async () => {
    const { db, fetch, commandsRun } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-authz-failed', to_agent: 'claude-acp-sonnet', status: 'failed' });

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-authz-failed', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_terminal');
    expect(commandsRun).toHaveLength(0);
  });

  it('(b) rejects shell run against a rejected handoff', async () => {
    const { db, fetch, commandsRun } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-authz-rejected', to_agent: 'claude-acp-sonnet', status: 'rejected' });

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-authz-rejected', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_terminal');
    expect(commandsRun).toHaveLength(0);
  });

  it('(b) rejects shell run against an expired handoff', async () => {
    const { db, fetch, commandsRun } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-authz-expired', to_agent: 'claude-acp-sonnet', status: 'expired' });

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-authz-expired', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_terminal');
    expect(commandsRun).toHaveLength(0);
  });

  it('(c) happy path: matching agent + active handoff executes the command', async () => {
    const { db, fetch, commandsRun } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-authz-ok', to_agent: 'claude-acp-sonnet', status: 'dispatched' });

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-authz-ok', agent_name: 'claude-acp-sonnet', command: 'echo ok' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.exit_code).toBe(0);
    expect(body.stdout).toBe('ok\n');
    expect(commandsRun).toHaveLength(1);
  });

  it('(d) rejects request for a handoff_id that does not exist in DB', async () => {
    const { fetch, commandsRun } = await makeSetup();

    const res = await fetch(`${BASE}/shell/run`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-ghost', agent_name: 'claude-acp-sonnet', command: 'echo hi' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_not_found');
    expect(commandsRun).toHaveLength(0);
  });
});

describe('shell/close — authz gate', () => {
  it('rejects close on a terminal handoff', async () => {
    const { db, fetch } = await makeSetup();
    insertHandoff(db, { handoff_id: 'h-close-done', to_agent: 'claude-acp-sonnet', status: 'completed' });

    const res = await fetch(`${BASE}/shell/close`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-close-done', session_id: 'sess-x' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_terminal');
  });

  it('returns 404 for close on unknown handoff', async () => {
    const { fetch } = await makeSetup();

    const res = await fetch(`${BASE}/shell/close`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ handoff_id: 'h-ghost-close', session_id: 'sess-x' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_not_found');
  });
});

describe('shell/list — authz gate', () => {
  it('returns 404 for list on unknown handoff', async () => {
    const { fetch } = await makeSetup();

    const res = await fetch(`${BASE}/shell/list?handoff_id=h-ghost-list`, {
      headers: AUTH,
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('handoff_not_found');
  });
});
