import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AcpTransportClosedError,
  HostInputError,
  StdioAcpClient,
  StdioAcpPermissionContext,
  createAcpWarmPool,
  handleStdioAcpPermissionRequest,
  initializeAcpSession,
  poolKeyFor,
  runProcess,
  startStdioAcpServer,
  superviseProcess,
} from "penumbra-exec-primitives";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fake-acp.mjs");

function tmpdir_(prefix) {
  return mkdtempSync(join(tmpdir(), `infra-host-${prefix}-`));
}

function infraEnv(dir, extra = {}) {
  return { PATH: process.env.PATH ?? "", HOME: dir, ...extra };
}

const NEVER = new AbortController().signal;

test("runProcess: env is verbatim — no ambient host vars leak into the child", async () => {
  const dir = tmpdir_("env");
  try {
    const result = await runProcess({
      command: "node",
      args: [
        "-e",
        'process.stdout.write([process.env.INFRA_MARKER ?? "", typeof process.env.PENUMBRA_SECRET, process.env.HOME ?? ""].join("|"))',
      ],
      cwd: dir,
      env: infraEnv(dir, { INFRA_MARKER: "infra-1" }),
      signal: NEVER,
      cancelGraceMs: 100,
      watchdogMs: 10_000,
    });
    assert.equal(result.stdout, `infra-1|undefined|${dir}`);
    assert.equal(result.exit.outcome, "exited");
    assert.equal(result.exit.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProcess: non-zero exit resolves with an ExitRecord instead of throwing", async () => {
  const dir = tmpdir_("exit");
  try {
    const result = await runProcess({
      command: "node",
      args: ["-e", "process.exit(3)"],
      cwd: dir,
      env: infraEnv(dir),
      signal: NEVER,
      cancelGraceMs: 100,
      watchdogMs: 10_000,
    });
    assert.equal(result.exit.outcome, "exited");
    assert.equal(result.exit.code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("superviseProcess: cancel escalates SIGTERM→SIGKILL; watchdog reports watchdog", async () => {
  const dir = tmpdir_("cancel");
  try {
    const cancelling = await superviseProcess({
      command: "sh",
      args: ["-c", 'trap "" TERM; echo ready; while :; do sleep 1; done'],
      cwd: dir,
      env: infraEnv(dir),
      signal: NEVER,
      cancelGraceMs: 150,
      watchdogMs: 30_000,
    });
    await new Promise((resolve) => {
      cancelling.stdout?.once("data", resolve);
    });
    cancelling.cancel();
    const record = await cancelling.exit;
    assert.equal(record.outcome, "cancelled");
    assert.equal(record.signal, "SIGKILL");

    const watched = await superviseProcess({
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
      env: infraEnv(dir),
      signal: NEVER,
      cancelGraceMs: 100,
      watchdogMs: 120,
    });
    const watchRecord = await watched.exit;
    assert.equal(watchRecord.outcome, "watchdog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host input validation: empty command and malformed env fail closed", async () => {
  const dir = tmpdir_("input");
  try {
    assert.throws(
      () =>
        superviseProcess({
          command: "",
          cwd: dir,
          env: infraEnv(dir),
          signal: NEVER,
          cancelGraceMs: 100,
          watchdogMs: 1000,
        }),
      (err) => err instanceof HostInputError,
    );
    assert.throws(
      () =>
        superviseProcess({
          command: "node",
          cwd: dir,
          env: null,
          signal: NEVER,
          cancelGraceMs: 100,
          watchdogMs: 1000,
        }),
      (err) => err instanceof HostInputError,
    );
    assert.throws(
      () => poolKeyFor({ agentKey: "a", env: {}, credentials: {}, specHash: "h" }),
      (err) => err instanceof HostInputError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closed transport rejects in-flight and new requests with AcpTransportClosedError", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new StdioAcpClient({ stdin, stdout });
  const pending = client.request("initialize", {});
  stdout.destroy();
  await assert.rejects(pending, (err) => err instanceof AcpTransportClosedError);
  await assert.rejects(client.request("session/new", {}), AcpTransportClosedError);
});

test("poolKeyFor: distinct credential scopes produce distinct keys", () => {
  const base = { agentKey: "a", env: { PATH: "/x" }, specHash: "h" };
  const k1 = poolKeyFor({ ...base, credentials: { credentialScope: "s1" } });
  const k2 = poolKeyFor({ ...base, credentials: { credentialScope: "s2" } });
  assert.notEqual(k1, k2);
});

test("warm pool: cross-scope acquire misses; same-scope hits; shutdown kills deposited handle", async () => {
  const pool = createAcpWarmPool({ sweepIntervalMs: 60_000 });
  const specA = {
    agentKey: "a",
    env: { PATH: "/x" },
    credentials: { credentialScope: "A" },
    specHash: "h",
  };
  const specB = { ...specA, credentials: { credentialScope: "B" } };
  let killed = 0;
  const handle = () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => {
      killed += 1;
    },
    exited: new Promise(() => {}),
    pid: undefined,
    getStderrTail: () => "",
    getSpawnError: () => null,
  });
  pool.deposit(specA, { client: {}, handle: handle() });
  assert.equal(pool.acquire(specB), null);
  assert.notEqual(pool.acquire(specA), null);
  pool.deposit(specA, { client: {}, handle: handle() });
  pool.shutdown();
  assert.equal(killed, 1);
});

test("permission: absent decide callback and malformed requests fail closed (cancelled)", async () => {
  const context = new StdioAcpPermissionContext();
  context.activate("s1");
  const host = {
    signal: new AbortController().signal,
    dispatchId: "infra-dispatch-1",
  };
  const malformed = await handleStdioAcpPermissionRequest(host, context, null);
  assert.equal(malformed.outcome.outcome, "cancelled");
  const noDecide = await handleStdioAcpPermissionRequest(host, context, {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "x", rawInput: {} },
    options: [{ kind: "allow_once", optionId: "allow_once" }],
  });
  assert.equal(noDecide.outcome.outcome, "cancelled");
});

test("full wire: spawn fixture, boot session with auth retry, prompt, tail, teardown", async () => {
  const dir = tmpdir_("wire");
  const logPath = join(dir, "wire.log");
  let handle;
  try {
    handle = await startStdioAcpServer({
      command: "node",
      args: [FIXTURE],
      cwd: dir,
      env: infraEnv(dir, { FAKE_ACP_LOG: logPath, FAKE_ACP_REQUIRE_AUTH: "1" }),
      signal: NEVER,
      cancelGraceMs: 300,
    });
    const client = new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout });
    const updates = [];
    client.on("session/update", (params) => updates.push(params));

    const session = await initializeAcpSession({
      client,
      clientInfo: { name: "infra-host", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false } },
      cwd: dir,
      signal: NEVER,
      bootDeadlineMs: 10_000,
      selectAuthMethod: (methods) => (methods.length > 0 ? methods[0].id : null),
    });
    assert.equal(session.sessionId, "fake-session-1");
    assert.equal(session.authMethods.length, 1);

    const prompt = await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping" }],
    });
    assert.equal(prompt.stopReason, "end_turn");
    assert.equal(updates.length, 1);

    const wire = readFileSync(logPath, "utf8");
    assert.match(wire, /"method":"authenticate"/);
    assert.match(wire, /"method":"session\/new"/);

    handle.kill();
    await handle.exited;
    assert.equal(existsSync(join(dir, "wire.log")), true);
  } finally {
    handle?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
