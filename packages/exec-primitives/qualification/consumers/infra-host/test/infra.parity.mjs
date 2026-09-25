/**
 * Infra-host contract suite — plain JS over the packed tarball's node_modules
 * install. Tags mirror the package suite: [B3] env/cwd boundary, [B4]
 * cancellation/watchdog, [B6] ACP session bootstrap, [B7] warm pool, [B8]
 * transport, [B10] host-input validation, [PERM] permission fail-closed,
 * [L6] module surface.
 */
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import * as primitives from "penumbra-exec-primitives";

import {
  ACP_CLIENT_CAPABILITIES,
  ACP_CLIENT_INFO,
  acpSpecFor,
  bootAcpSession,
  createPool,
  poolKeyOf,
} from "../src/acp.mjs";
import { denyAllPermission, StdioAcpPermissionContext, unhandledHost } from "../src/permission.mjs";
import { ALLOWED_ENV_NAMES, buildChildEnv, spawnFn, spawnFnLines } from "../src/spawn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = join(HERE, "..");
const FAKE_ACP = join(HERE, "..", "fixtures", "fake-acp.mjs");
const freshSignal = () => new AbortController().signal;

const DENY_OPTIONS = [
  { kind: "allow_always", optionId: "allow_always" },
  { kind: "allow_once", optionId: "allow_once" },
  { kind: "reject_once", optionId: "reject_once" },
];

function fakeHandle() {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    exited: new Promise(() => {}),
    kill: () => {},
    getStderrTail: () => "",
  };
}

describe("infra-host [B3] env boundary", () => {
  test("spawnFn passes allowlisted vars and drops ambient secrets", async () => {
    const env = {
      ...process.env,
      INFRA_MARKER: "infra-marked",
      SHAREDLIB6_LEAK: "should-not-pass",
    };
    const out = await spawnFn(
      ["sh", "-c", 'printf "marker=%s leak=%s" "$INFRA_MARKER" "${SHAREDLIB6_LEAK:-unset}"'],
      env,
      CWD,
      { signal: freshSignal() },
    );
    expect(out.stdout).toBe("marker=infra-marked leak=unset");
    expect(out.exitCode).toBe(0);
  });

  test("child env contains only allowlisted names", async () => {
    const env = { ...process.env, SHAREDLIB6_LEAK: "should-not-pass", INFRA_MARKER: "m" };
    const out = await spawnFn(["env"], env, CWD, { signal: freshSignal() });
    const keys = out.stdout
      .split("\n")
      .map((line) => line.split("=")[0])
      .filter((key) => key !== undefined && key.length > 0);
    for (const key of keys) {
      expect(ALLOWED_ENV_NAMES).toContain(key);
    }
    expect(keys).not.toContain("SHAREDLIB6_LEAK");
    expect(keys).toContain("INFRA_MARKER");
  });
});

describe("infra-host [B4] process supervision", () => {
  test("spawnFn resolves a nonzero exit instead of throwing", async () => {
    const out = await spawnFn(["sh", "-c", 'echo "oops" 1>&2; exit 3'], process.env, CWD, {
      signal: freshSignal(),
    });
    expect(out.exitCode).toBe(3);
    expect(out.outcome).toBe("exited");
    expect(out.stderr).toContain("oops");
  });

  test("cancellation escalates SIGTERM to SIGKILL after the grace", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const promise = spawnFn(
      ["sh", "-c", 'trap "" TERM; while :; do sleep 1; done'],
      process.env,
      CWD,
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 30);
    const out = await promise;
    const elapsed = Date.now() - start;
    expect(out.outcome).toBe("cancelled");
    expect(out.signal).toBe("SIGKILL");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("watchdog SIGKILLs a hung child at the host deadline", async () => {
    const start = Date.now();
    const out = await spawnFn(["sleep", "30"], process.env, CWD, {
      signal: freshSignal(),
      deadlineMs: 150,
    });
    const elapsed = Date.now() - start;
    expect(out.outcome).toBe("watchdog");
    expect(out.signal).toBe("SIGKILL");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("spawnFnLines streams complete lines as they arrive", async () => {
    const lines = [];
    const out = await spawnFnLines(
      ["sh", "-c", 'printf "one\\ntwo\\n"; sleep 0.05; printf "three\\n"'],
      process.env,
      CWD,
      { signal: freshSignal(), onLine: (line, stream) => lines.push([stream, line]) },
    );
    expect(out.exitCode).toBe(0);
    expect(lines.map(([, line]) => line)).toEqual(["one", "two", "three"]);
  });
});

describe("infra-host [B10] host-input validation", () => {
  test("runProcess requires explicit host-owned inputs", async () => {
    let caught;
    try {
      await primitives.runProcess({ command: "true" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(primitives.HostInputError);
  });

  test("initializeAcpSession requires explicit client identity", async () => {
    await expect(primitives.initializeAcpSession({})).rejects.toBeInstanceOf(
      primitives.HostInputError,
    );
  });
});

describe("infra-host [B8] transport boundary", () => {
  test("requests on a closed transport reject with AcpTransportClosedError", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new primitives.StdioAcpClient({ stdin, stdout });
    stdout.destroy();
    await expect(client.request("session/new", {})).rejects.toBeInstanceOf(
      primitives.AcpTransportClosedError,
    );
  });
});

describe("infra-host [B7] warm pool", () => {
  test("credential scope isolates pooled entries", () => {
    const pool = createPool();
    try {
      const envA = { ...process.env, INFRA_MARKER: "tenant-a" };
      const envB = { ...process.env, INFRA_MARKER: "tenant-b" };
      const specA = acpSpecFor(envA, CWD);
      const specB = acpSpecFor(envB, CWD);
      expect(specA.credentialScope).not.toBe(specB.credentialScope);
      expect(poolKeyOf(envA, CWD)).not.toBe(poolKeyOf(envB, CWD));

      const handle = fakeHandle();
      expect(pool.deposit(specA, { handle, client: {} })).not.toBeNull();
      expect(pool.acquire(specB)).toBeNull();
      expect(pool.acquire(specA)?.handle).toBe(handle);
    } finally {
      pool.shutdown();
    }
  });

  test("poolKeyFor refuses a missing credential scope", () => {
    expect(() => primitives.poolKeyFor({ agent: "a", cwd: "/x" })).toThrow(
      primitives.HostInputError,
    );
  });
});

describe("infra-host [PERM] permission fail-closed", () => {
  test("a request with no decide callback resolves cancelled", async () => {
    const context = new StdioAcpPermissionContext();
    context.activate("s-1");
    context.observe("s-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "fake/tool",
      input: { command: "x" },
    });
    const result = await primitives.handleStdioAcpPermissionRequest(
      unhandledHost(freshSignal()),
      context,
      { sessionId: "s-1", toolCall: { toolCallId: "tool-1" }, options: DENY_OPTIONS },
    );
    expect(result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("deny-all decides reject_once", async () => {
    const context = new StdioAcpPermissionContext();
    context.activate("s-1");
    context.observe("s-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "fake/tool",
      input: { command: "x" },
    });
    const result = await denyAllPermission(freshSignal(), context, {
      sessionId: "s-1",
      toolCall: { toolCallId: "tool-1" },
      options: DENY_OPTIONS,
    });
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });
});

describe("infra-host [B6] ACP session over the packed wire", () => {
  test("boots initialize → session/new → session/prompt against fake-acp", async () => {
    const booted = await bootAcpSession(FAKE_ACP, process.env, CWD, { signal: freshSignal() });
    try {
      expect(booted.session.sessionId).toBe("fake-session-1");
      const promptResult = await booted.client.request("session/prompt", {
        sessionId: booted.session.sessionId,
        prompt: [{ type: "text", text: "ping" }],
      });
      expect(promptResult.stopReason).toBe("end_turn");
    } finally {
      booted.handle.kill();
      await booted.handle.exited;
    }
  });

  test("authenticates once and retries session/new when required", async () => {
    const booted = await bootAcpSession(FAKE_ACP, process.env, CWD, {
      signal: freshSignal(),
      requireAuth: true,
    });
    try {
      expect(booted.session.sessionId).toBe("fake-session-1");
      expect(booted.session.authMethods).toEqual([{ id: "env", type: "env_var" }]);
    } finally {
      booted.handle.kill();
      await booted.handle.exited;
    }
  });

  test("a permission request over the wire is denied and the prompt still completes", async () => {
    const booted = await bootAcpSession(FAKE_ACP, process.env, CWD, {
      signal: freshSignal(),
      askPermission: true,
    });
    const context = new StdioAcpPermissionContext();
    context.activate(booted.session.sessionId);
    const seen = [];
    booted.client.onRequest("session/request_permission", (params) => {
      const host = unhandledHost(freshSignal());
      const decision = primitives.handleStdioAcpPermissionRequest(host, context, params);
      seen.push(decision);
      return decision;
    });
    try {
      const promptResult = await booted.client.request("session/prompt", {
        sessionId: booted.session.sessionId,
        prompt: [{ type: "text", text: "do something guarded" }],
      });
      expect(promptResult.stopReason).toBe("end_turn");
      expect(seen).toHaveLength(1);
      expect(await seen[0]).toEqual({ outcome: { outcome: "cancelled" } });
    } finally {
      booted.handle.kill();
      await booted.handle.exited;
    }
  });
});

describe("infra-host [L6] packed module surface", () => {
  test("namespace exposes the documented runtime exports", () => {
    for (const name of [
      "AcpResponseError",
      "AcpTransportClosedError",
      "HostInputError",
      "StdioAcpClient",
      "StdioAcpPermissionContext",
      "createAcpWarmPool",
      "detectCapacityError",
      "handleStdioAcpPermissionRequest",
      "initializeAcpSession",
      "poolKeyFor",
      "runProcess",
      "selectConfigOption",
      "selectTrustAllOption",
      "startStdioAcpServer",
      "superviseProcess",
    ]) {
      expect(primitives[name]).toBeDefined();
    }
  });
});
