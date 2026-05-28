import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as net from "node:net";
import { startAcpServer, type AcpServerSpawner } from "../../src/adapters/acp-server.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  readonly kill = mock((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : null;
    queueMicrotask(() => {
      if (this.exitCode === null) this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
    });
    return true;
  });

  constructor(pid = 4321) {
    super();
    this.pid = pid;
  }
}

function createSpawn(child: FakeChildProcess, onSpawn?: (args: string[]) => void) {
  return mock((_command: string, args: string[], _options: unknown) => {
    onSpawn?.(args);
    return child as unknown as ReturnType<AcpServerSpawner>;
  }) as AcpServerSpawner & ReturnType<typeof mock>;
}

test("startAcpServer resolves when port is successfully bound and kill sends SIGTERM", async () => {
  const child = new FakeChildProcess(5432);
  let assignedPort = 0;

  const dummyServer = net.createServer((socket) => socket.destroy());

  const spawn = createSpawn(child, (args) => {
    const portIdx = args.indexOf("--port") + 1;
    assignedPort = Number(args[portIdx]);
    dummyServer.listen(assignedPort, "127.0.0.1");
  });

  const handlePromise = startAcpServer({
    cwd: "/tmp/penumbra-acp",
    spawn,
    bootTimeoutMs: 250,
  });

  const handle = await handlePromise;
  dummyServer.close();

  expect(handle.port).toBe(assignedPort);
  expect(handle.baseUrl).toBe(`http://127.0.0.1:${assignedPort}`);
  expect(handle.pid).toBe(5432);
  expect(spawn.mock.calls[0]?.[0]).toBe("opencode");
  expect(spawn.mock.calls[0]?.[1]).toEqual([
    "acp",
    "--port",
    assignedPort.toString(),
    "--cwd",
    "/tmp/penumbra-acp",
    "--pure",
  ]);

  await handle.kill();

  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

test("startAcpServer rejects and kills the child when aborted during boot", async () => {
  const child = new FakeChildProcess();
  const spawn = createSpawn(child);
  const controller = new AbortController();

  const handlePromise = startAcpServer({
    cwd: "/tmp/penumbra-acp",
    spawn,
    signal: controller.signal,
    bootTimeoutMs: 250,
  });

  // Give startAcpServer time to resolve getFreePort and spawn the child
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await expect(handlePromise).rejects.toThrow("ACP server start aborted");
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

test("startAcpServer rejects and kills the child when boot timeout expires", async () => {
  const child = new FakeChildProcess();
  const spawn = createSpawn(child);

  await expect(
    startAcpServer({
      cwd: "/tmp/penumbra-acp",
      spawn,
      bootTimeoutMs: 10,
    }),
  ).rejects.toThrow(/Timed out waiting for port/);

  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

const integrationEnabled =
  process.env.PENUMBRA_RUN_OPENCODE_INTEGRATION === "1" && Boolean(Bun.which("opencode"));

test.if(integrationEnabled)("startAcpServer can spawn a real opencode ACP process", async () => {
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
