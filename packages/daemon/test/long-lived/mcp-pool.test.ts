import { expect, mock, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createMcpPool } from '../../src/long-lived/mcp-pool.js';

const fixture = join(import.meta.dir, '../fixtures/echo-mcp.ts');

function makeSpec(overrides: Partial<{ env: Array<{ name: string; value: string }> }> = {}) {
  return {
    name: 'echo',
    command: 'bun',
    args: ['run', fixture],
    env: overrides.env ?? [],
  };
}

test('ensureRunning initializes and caches tools', async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  expect(await pool.listTools('echo')).toEqual([
    { name: 'echo', description: 'echoes its args' },
  ]);
  await pool.shutdown();
});

test('ensureRunning is idempotent for the same server', async () => {
  const spawnChildProcess = mock(spawn);
  const pool = createMcpPool({ spawnChildProcess: spawnChildProcess as any });
  const spec = makeSpec();
  await pool.ensureRunning(spec);
  await pool.ensureRunning(spec);
  expect(spawnChildProcess).toHaveBeenCalledTimes(1);
  await pool.shutdown();
});

test('acquire and release update refcounts and last release time', async () => {
  let current = 100;
  const pool = createMcpPool({ now: () => current });
  await pool.ensureRunning(makeSpec());
  const state = (pool as any)._state('echo');
  expect(state.refs.size).toBe(0);
  pool.acquire('a1', 'echo');
  expect(state.refs.size).toBe(1);
  pool.release('a1', 'echo');
  expect(state.refs.size).toBe(0);
  expect(state.lastReleaseAt).toBe(100);
  await pool.shutdown();
});

test('sweep tears down idle subprocesses after grace', async () => {
  let current = 100;
  const pool = createMcpPool({ now: () => current, graceMs: 10 });
  await pool.ensureRunning(makeSpec());
  pool.release('a1', 'echo');
  current = 111;
  (pool as any)._sweep();
  await Bun.sleep(20);
  expect((pool as any)._state('echo')).toBeUndefined();
});

test('reacquire before grace prevents teardown', async () => {
  let current = 100;
  const pool = createMcpPool({ now: () => current, graceMs: 50 });
  await pool.ensureRunning(makeSpec());
  pool.acquire('a1', 'echo');
  pool.release('a1', 'echo');
  current = 120;
  pool.acquire('a1', 'echo');
  (pool as any)._sweep();
  expect((pool as any)._state('echo')).toBeDefined();
  await pool.shutdown();
});

test('shutdown kills all children', async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  const proc = (pool as any)._state('echo').proc;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  await pool.shutdown();
  await exited;
});

test('callTool round-trips to the server', async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  const result = await pool.callTool('echo', 'echo', { hello: 'world' });
  expect(result).toEqual({
    content: [{ type: 'text', text: '{"hello":"world"}' }],
  });
  await pool.shutdown();
});

test('callTool times out when the server stalls', async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec({ env: [{ name: 'ECHO_DELAY_MS', value: '200' }] }));
  await expect(pool.callTool('echo', 'echo', {}, { timeoutMs: 50 })).rejects.toThrow('mcp_call_timeout');
  await pool.shutdown();
});

test('callTool rejects when the subprocess exits mid-call', async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  const proc = (pool as any)._state('echo').proc;
  const inFlight = pool.callTool('echo', 'echo', {});
  proc.kill('SIGTERM');
  await expect(inFlight).rejects.toThrow('mcp_disconnected');
  await pool.shutdown();
});

test('callTool lazily restarts after a disconnect', async () => {
  const spawnChildProcess = mock(spawn);
  const pool = createMcpPool({ spawnChildProcess: spawnChildProcess as any });
  await pool.ensureRunning(makeSpec());
  const proc = (pool as any)._state('echo').proc;
  proc.kill('SIGTERM');
  await expect(pool.callTool('echo', 'echo', {})).rejects.toThrow('mcp_disconnected');
  await Bun.sleep(50);
  await pool.callTool('echo', 'echo', { ok: true });
  expect(spawnChildProcess).toHaveBeenCalledTimes(2);
  await pool.shutdown();
});

test('callTool maps server errors', async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  await expect(pool.callTool('echo', 'unknown', {})).rejects.toThrow('method_not_found');
  await pool.shutdown();
});
