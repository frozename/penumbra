import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startAcpServer, type AcpServerSpawner } from '../../src/adapters/acp-server.js';

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  readonly kill = mock((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : null;
    queueMicrotask(() => {
      if (this.exitCode === null) this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', this.exitCode, this.signalCode);
      this.emit('close', this.exitCode, this.signalCode);
    });
    return true;
  });

  constructor(pid = 4321) {
    super();
    this.pid = pid;
  }

  emitStdout(text: string) {
    this.stdout.write(text);
  }

  emitStderr(text: string) {
    this.stderr.write(text);
  }
}

function createSpawn(child: FakeChildProcess) {
  return mock((_command: string, _args: string[], _options: unknown) => {
    return child as unknown as ReturnType<AcpServerSpawner>;
  }) as AcpServerSpawner & ReturnType<typeof mock>;
}

test('startAcpServer resolves when stdout reports a port and kill sends SIGTERM', async () => {
  const child = new FakeChildProcess(5432);
  const spawn = createSpawn(child);

  const handlePromise = startAcpServer({
    cwd: '/tmp/penumbra-acp',
    spawn,
    bootTimeoutMs: 250,
  });

  child.emitStdout('ACP listening at http://127.0.0.1:54321\n');

  const handle = await handlePromise;
  expect(handle.port).toBe(54321);
  expect(handle.baseUrl).toBe('http://127.0.0.1:54321');
  expect(handle.pid).toBe(5432);
  expect(spawn.mock.calls[0]?.[0]).toBe('opencode');
  expect(spawn.mock.calls[0]?.[1]).toEqual([
    'acp',
    '--port',
    '0',
    '--cwd',
    '/tmp/penumbra-acp',
    '--pure',
  ]);

  await handle.kill();

  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('startAcpServer rejects and kills the child when aborted during boot', async () => {
  const child = new FakeChildProcess();
  const spawn = createSpawn(child);
  const controller = new AbortController();

  const handlePromise = startAcpServer({
    cwd: '/tmp/penumbra-acp',
    spawn,
    signal: controller.signal,
    bootTimeoutMs: 250,
  });

  controller.abort();

  await expect(handlePromise).rejects.toThrow('ACP server start aborted');
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('startAcpServer rejects and kills the child when boot timeout expires', async () => {
  const child = new FakeChildProcess();
  const spawn = createSpawn(child);

  await expect(
    startAcpServer({
      cwd: '/tmp/penumbra-acp',
      spawn,
      bootTimeoutMs: 10,
    }),
  ).rejects.toThrow('ACP server did not report a port within 10ms');

  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

const integrationEnabled =
  process.env.PENUMBRA_RUN_OPENCODE_INTEGRATION === '1' && Boolean(Bun.which('opencode'));

test.if(integrationEnabled)('startAcpServer can spawn a real opencode ACP process', async () => {
  const controller = new AbortController();
  const handle = await startAcpServer({
    cwd: process.cwd(),
    signal: controller.signal,
    bootTimeoutMs: 5_000,
  });

  expect(handle.port).toBeGreaterThan(0);
  expect(handle.baseUrl).toBe(`http://127.0.0.1:${handle.port}`);

  controller.abort();
  await handle.exited;
});
