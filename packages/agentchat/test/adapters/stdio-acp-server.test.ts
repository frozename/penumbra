import { afterEach, describe, expect, test } from 'bun:test';
import { startStdioAcpServer } from '../../src/adapters/stdio-acp-server.js';

const cleanupPids = new Set<number>();

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  cleanupPids.clear();
});

describe('startStdioAcpServer', () => {
  test('kill escalates when the ACP process ignores SIGTERM', async () => {
    const handle = await startStdioAcpServer({
      binary: 'sh',
      args: ['-c', 'trap "" TERM; while :; do sleep 1; done'],
    });
    if (handle.pid) cleanupPids.add(handle.pid);

    handle.kill();

    const exited = await Promise.race([
      handle.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_500)),
    ]);

    expect(exited).toBe(true);
    if (handle.pid) cleanupPids.delete(handle.pid);
  });
});
