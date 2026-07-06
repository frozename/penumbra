import type { HostedMcpServer } from "@penumbra/agentchat/config/types";

import { expect, mock, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { createMcpPool } from "../../src/long-lived/mcp-pool.js";

const fixture = join(import.meta.dir, "../fixtures/echo-mcp.ts");

type Pool = ReturnType<typeof createMcpPool>;
type McpState = NonNullable<ReturnType<Pool["_state"]>>;

interface JsonRpcRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

// FakeStdout doubles as a Readable-like stream + EventEmitter for the pool's
// on("data", ...) wiring. setEncoding is required at runtime and is inert in
// tests; the comment satisfies @typescript-eslint/no-empty-function.
class FakeStdout extends EventEmitter {
  writable = true;
  setEncoding(): void {
    /* fake stream noop */
  }
}

interface FakeProcSetup {
  proc: ChildProcess;
  stdout: FakeStdout;
}

// One documented test-helper cast: the fake child is an EventEmitter with
// stdin/stdout/kill grafted on — structurally close to ChildProcess but its
// overload-heavy nominal type can't be satisfied without laundering.
function makeFakeProc(onRequest: (req: JsonRpcRequest, stdout: FakeStdout) => void): FakeProcSetup {
  const stdout = new FakeStdout();
  const stdin = {
    writable: true,
    write(chunk: string): boolean {
      const req = parseJsonRpcRequest(chunk);
      onRequest(req, stdout);
      return true;
    },
  };
  const emitter = new EventEmitter();
  const augmented = Object.assign(emitter, {
    stdin,
    stdout,
    kill: (): void => {
      /* fake child noop */
    },
  });
  return { proc: augmented as unknown as ChildProcess, stdout };
}

// One documented test-helper cast: bun:test's Mock<F> wraps F at runtime but
// its type lacks the overload list of `typeof spawn`, so a partial
// `() => ChildProcess` mock can't be assigned without laundering.
function asSpawn(fn: unknown): typeof spawn {
  return fn as typeof spawn;
}

function makeSpec(
  overrides: Partial<{ env: { name: string; value: string }[] }> = {},
): HostedMcpServer {
  return {
    name: "echo",
    command: "bun",
    args: ["run", fixture],
    env: overrides.env ?? [],
  };
}

function parseJsonRpcRequest(chunk: string): JsonRpcRequest {
  const raw: unknown = JSON.parse(chunk);
  if (typeof raw !== "object" || raw === null || !("method" in raw)) {
    throw new Error("invalid mcp request frame");
  }
  return raw as JsonRpcRequest;
}

function emitJson(stdout: FakeStdout, payload: Record<string, unknown>): void {
  stdout.emit("data", JSON.stringify(payload) + "\n");
}

// bun:test's `.rejects.toThrow(...)` is typed as void even though it awaits
// the underlying promise at runtime. Wrapping the await-and-match dance keeps
// every call site lint-clean (no void-in-expression, no awaiting void).
async function expectRejection(
  promise: Promise<unknown>,
  expected: string | RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = caught instanceof Error ? caught.message : String(caught);
  if (typeof expected === "string") {
    expect(message).toContain(expected);
  } else {
    expect(message).toMatch(expected);
  }
}

// Pool's callTool typed `_meta` as Record<string, unknown>, but the runtime
// path explicitly rejects non-Record shapes (arrays etc.). One laundering
// helper lets tests exercise that defensive branch from a typed call site.
function callToolWithRawMeta(
  pool: Pool,
  serverName: string,
  toolName: string,
  args: unknown,
  meta: unknown,
): Promise<unknown> {
  return pool.callTool(serverName, toolName, args, {
    _meta: meta as Record<string, unknown>,
  });
}

// proc.once returns ChildProcess; wrap in a block so the new Promise body
// doesn't return that ChildProcess (which would trip no-unsafe-return).
function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    proc.once("exit", () => {
      resolve();
    });
  });
}

function getStateOrThrow(pool: Pool, name: string): McpState {
  const state = pool._state(name);
  if (!state) throw new Error(`expected mcp state for ${name}`);
  return state;
}

test("ensureRunning initializes and caches tools", async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  expect(await pool.listTools("echo")).toEqual([{ name: "echo", description: "echoes its args" }]);
  expect(pool.getFederationHealth()).toEqual({
    registered: [{ server: "echo", tool: "echo", name: "echo.echo" }],
    skipped: [],
  });
  await pool.shutdown();
});

test("getFederationHealth prunes stale skip entries after recovery", async () => {
  const failing = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "tools_unavailable" },
      });
    }
  });
  const succeeding = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "echo", description: "echoes its args" }] },
      });
    }
  });
  const spawnChildProcess = mock()
    .mockReturnValueOnce(failing.proc)
    .mockReturnValueOnce(succeeding.proc);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  const spec: HostedMcpServer = {
    name: "flappy",
    command: "bun",
    args: ["run", fixture],
    env: [],
  };

  await expectRejection(pool.ensureRunning(spec), "tools_unavailable");
  expect(pool.getFederationHealth().skipped).toEqual([
    { server: "flappy", tool: "flappy", reason: "tools_unavailable" },
  ]);

  await pool.ensureRunning(spec);
  expect(pool.getFederationHealth()).toEqual({
    registered: [{ server: "flappy", tool: "echo", name: "flappy.echo" }],
    skipped: [],
  });
  await pool.shutdown();
});

test("callTool records a post-boot restart failure as skipped", async () => {
  const first = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "echo", description: "echoes its args" }] },
      });
    }
  });
  const second = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "restart_failed" },
      });
    }
  });
  const spawnChildProcess = mock().mockReturnValueOnce(first.proc).mockReturnValueOnce(second.proc);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  const spec: HostedMcpServer = {
    name: "crash-and-burn",
    command: "bun",
    args: ["run", fixture],
    env: [],
  };

  await pool.ensureRunning(spec);
  expect(pool.getFederationHealth().skipped).toEqual([]);

  const state = getStateOrThrow(pool, "crash-and-burn");
  state.proc.emit("close");

  await expectRejection(pool.callTool("crash-and-burn", "echo", {}), "restart_failed");

  expect(pool.getFederationHealth().skipped).toEqual([
    { server: "crash-and-burn", tool: "crash-and-burn", reason: "restart_failed" },
  ]);
  await pool.shutdown();
});

test("getFederationHealth retains skipped bootstrap failures", async () => {
  const { proc } = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "tools_unavailable" },
      });
    }
  });
  const spawnChildProcess = mock(() => proc);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  await expectRejection(
    pool.ensureRunning({ name: "missing", command: "bun", args: ["run", fixture], env: [] }),
    "tools_unavailable",
  );
  expect(pool.getFederationHealth()).toEqual({
    registered: [],
    skipped: [{ server: "missing", tool: "missing", reason: "tools_unavailable" }],
  });
  await pool.shutdown();
});

test("ensureRunning is idempotent for the same server", async () => {
  const spawnChildProcess = mock(spawn);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  const spec = makeSpec();
  await pool.ensureRunning(spec);
  await pool.ensureRunning(spec);
  expect(spawnChildProcess).toHaveBeenCalledTimes(1);
  await pool.shutdown();
});

test("ensureRunning restarts when the spec changes", async () => {
  const spawnChildProcess = mock(spawn);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  const first = makeSpec();
  const second = makeSpec({ env: [{ name: "ECHO_DELAY_MS", value: "200" }] });

  await pool.ensureRunning(first);
  const firstProc = getStateOrThrow(pool, "echo").proc;

  await pool.ensureRunning(second);
  await Bun.sleep(20);

  expect(spawnChildProcess).toHaveBeenCalledTimes(2);
  expect(firstProc.killed).toBeTrue();
  expect(getStateOrThrow(pool, "echo").spec.env).toEqual([{ name: "ECHO_DELAY_MS", value: "200" }]);
  await pool.shutdown();
});

test("ensureRunning kills a replaced non-running subprocess", async () => {
  const first = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "echo", description: "echoes its args" }] },
      });
    }
  });
  const second = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "echo", description: "echoes its args" }] },
      });
    }
  });
  const firstKill = mock(() => true);
  const secondKill = mock(() => true);
  Object.assign(first.proc, { kill: firstKill });
  Object.assign(second.proc, { kill: secondKill });
  const spawnChildProcess = mock().mockReturnValueOnce(first.proc).mockReturnValueOnce(second.proc);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  const spec = { name: "echo", command: "bun", args: ["run", fixture], env: [] };

  await pool.ensureRunning(spec);
  await pool.ensureRunning(spec);

  expect(spawnChildProcess).toHaveBeenCalledTimes(2);
  expect(firstKill).toHaveBeenCalledTimes(1);
  expect(secondKill).not.toHaveBeenCalled();
  await pool.shutdown();
});

test("acquire and release update refcounts and last release time", async () => {
  const current = 100;
  const pool = createMcpPool({ now: () => current });
  await pool.ensureRunning(makeSpec());
  const state = getStateOrThrow(pool, "echo");
  expect(state.refs.size).toBe(0);
  pool.acquire("a1", "echo");
  expect(state.refs.size).toBe(1);
  pool.release("a1", "echo");
  expect(state.refs.size).toBe(0);
  expect(state.lastReleaseAt).toBe(100);
  await pool.shutdown();
});

test("sweep tears down idle subprocesses after grace", async () => {
  let current = 100;
  const pool = createMcpPool({ now: () => current, graceMs: 10 });
  await pool.ensureRunning(makeSpec());
  pool.release("a1", "echo");
  current = 111;
  pool._sweep();
  await Bun.sleep(20);
  expect(pool._state("echo")).toBeUndefined();
});

test("reacquire before grace prevents teardown", async () => {
  let current = 100;
  const pool = createMcpPool({ now: () => current, graceMs: 50 });
  await pool.ensureRunning(makeSpec());
  pool.acquire("a1", "echo");
  pool.release("a1", "echo");
  current = 120;
  pool.acquire("a1", "echo");
  pool._sweep();
  expect(pool._state("echo")).toBeDefined();
  await pool.shutdown();
});

test("shutdown kills all children", async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  const proc = getStateOrThrow(pool, "echo").proc;
  const exited = waitForExit(proc);
  await pool.shutdown();
  await exited;
});

test("callTool round-trips to the server", async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  const result = await pool.callTool("echo", "echo", { hello: "world" });
  expect(result).toEqual({
    content: [{ type: "text", text: '{"hello":"world"}' }],
  });
  await pool.shutdown();
});

test("callTool forwards params._meta when provided", async () => {
  let seenCallParams: Record<string, unknown> | null = null;
  const { proc } = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "echo", description: "echoes its args" }] },
      });
    } else if (req.method === "tools/call") {
      seenCallParams = req.params ?? null;
      emitJson(stdout, { jsonrpc: "2.0", id: req.id, result: { ok: true } });
    }
  });
  const spawnChildProcess = mock(() => proc);

  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });

  await pool.ensureRunning({
    name: "meta-server",
    command: "bun",
    args: ["run", fixture],
    env: [],
  });
  const result = await pool.callTool(
    "meta-server",
    "echo",
    { hello: "world" },
    { _meta: { origin: "claude-code" } },
  );
  expect(result).toEqual({ ok: true });
  expect(seenCallParams).toEqual({
    name: "echo",
    arguments: { hello: "world" },
    _meta: { origin: "claude-code" },
  });
  await pool.shutdown();
});

test("_meta array is not forwarded to outgoing params._meta", async () => {
  let seenCallParams: Record<string, unknown> | null = null;
  const { proc } = makeFakeProc((req, stdout) => {
    if (req.method === "initialize") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      });
    } else if (req.method === "tools/list") {
      emitJson(stdout, {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "echo", description: "echoes its args" }] },
      });
    } else if (req.method === "tools/call") {
      seenCallParams = req.params ?? null;
      emitJson(stdout, { jsonrpc: "2.0", id: req.id, result: { ok: true } });
    }
  });
  const spawnChildProcess = mock(() => proc);

  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });

  await pool.ensureRunning({
    name: "meta-array-server",
    command: "bun",
    args: ["run", fixture],
    env: [],
  });
  const result = await callToolWithRawMeta(
    pool,
    "meta-array-server",
    "echo",
    { hello: "world" },
    [],
  );
  expect(result).toEqual({ ok: true });
  expect(seenCallParams).toEqual({
    name: "echo",
    arguments: { hello: "world" },
  });
  await pool.shutdown();
});

test("callTool times out when the server stalls", async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec({ env: [{ name: "ECHO_DELAY_MS", value: "200" }] }));
  await expectRejection(pool.callTool("echo", "echo", {}, { timeoutMs: 50 }), "mcp_call_timeout");
  await pool.shutdown();
});

test("callTool rejects when the subprocess exits mid-call", async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  const proc = getStateOrThrow(pool, "echo").proc;
  const inFlight = pool.callTool("echo", "echo", {});
  proc.kill("SIGTERM");
  await expectRejection(inFlight, "mcp_disconnected");
  await pool.shutdown();
});

test("callTool lazily restarts after a disconnect", async () => {
  const spawnChildProcess = mock(spawn);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  await pool.ensureRunning(makeSpec());
  const proc = getStateOrThrow(pool, "echo").proc;
  proc.kill("SIGTERM");
  await expectRejection(pool.callTool("echo", "echo", {}), "mcp_disconnected");
  await Bun.sleep(50);
  await pool.callTool("echo", "echo", { ok: true });
  expect(spawnChildProcess).toHaveBeenCalledTimes(2);
  await pool.shutdown();
});

test("callTool maps server errors", async () => {
  const pool = createMcpPool();
  await pool.ensureRunning(makeSpec());
  await expectRejection(pool.callTool("echo", "unknown", {}), "method_not_found");
  await pool.shutdown();
});

test("callTool rejects for unknown servers", async () => {
  const pool = createMcpPool();
  await expectRejection(pool.callTool("does-not-exist", "echo", {}), "mcp_unavailable");
  await pool.shutdown();
});

test("kills subprocesses when stdout lines grow too large", async () => {
  const spawnChildProcess = mock(spawn);
  const pool = createMcpPool({ spawnChildProcess: asSpawn(spawnChildProcess) });
  await pool.ensureRunning(makeSpec());
  const proc = getStateOrThrow(pool, "echo").proc;
  const killed = waitForExit(proc);

  const stdout = proc.stdout;
  if (!stdout) throw new Error("expected proc.stdout");
  stdout.emit("data", "x".repeat(2 * 1024 * 1024));

  await killed;
  expect(proc.killed).toBeTrue();
  await pool.shutdown();
});
