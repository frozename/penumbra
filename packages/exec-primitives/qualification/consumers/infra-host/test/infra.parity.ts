/**
 * Infra-host contract suite — TypeScript over the packed tarball's own
 * node_modules install. Ids on titles mirror the qualification matrix:
 * [T1] spawn shape, [T3]/[T4] cancel-grace and dispatch-deadline honored at
 * both values while the PENUMBRA_* env knobs stay inert, [T6] group teardown,
 * [T7] warm pool under PENUMBRA_WARM_PREWARM_CAP=0, [ACP-CLIENTINFO] and
 * [ACP-ENVKEYS] wire assertions, [PERM-DENY] deny-by-default, [SCOPE-2]
 * credential isolation, [B8] closed transport, [PARTIAL-NONZERO] and
 * [ERROR-THEN-EXIT] exit surfaces, [GUARD] workspace-resolution tripwire.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import * as primitives from "penumbra-exec-primitives";

import {
  ACP_CLIENT_CAPABILITIES,
  ACP_CLIENT_INFO,
  ACP_PROTOCOL_VERSION,
  acpSpecFor,
  bootAcpSession,
  createPool,
  credentialScopeFor,
  poolKeyOf,
} from "../src/acp.ts";
import {
  DenyAllPermissionHost,
  denyAllPermission,
  StdioAcpPermissionContext,
  unhandledHost,
} from "../src/permission.ts";
import {
  ALLOWED_ENV_NAMES,
  buildChildEnv,
  spawnFn,
  spawnFnLines,
  type HostEnv,
} from "../src/spawn.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = join(HERE, "..");
const FAKE_ACP = join(HERE, "..", "fixtures", "fake-acp.mjs");
const freshSignal = (): AbortSignal => new AbortController().signal;

/**
 * Inert ambient knobs: set in the host env to prove the library never reads
 * them — behavior must follow the explicit host inputs instead. They are not
 * allowlisted, so buildChildEnv drops them before the child sees anything.
 */
const INERT_ENV: HostEnv = {
  PENUMBRA_CANCEL_GRACE_S: "60",
  PENUMBRA_DISPATCH_TIMEOUT_S: "60",
  PENUMBRA_WARM_PREWARM_CAP: "0",
};

function hostEnv(extra: HostEnv = {}): HostEnv {
  return { ...process.env, ...INERT_ENV, ...extra };
}

const DENY_OPTIONS = [
  { kind: "allow_always", optionId: "allow_always" },
  { kind: "allow_once", optionId: "allow_once" },
  { kind: "reject_once", optionId: "reject_once" },
];

function fakeHandle(): primitives.StdioAcpHandle {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    exited: new Promise(() => {}),
    kill: () => {},
    getStderrTail: () => "",
    getSpawnError: () => null,
  };
}

describe("infra-host spawn surface", () => {
  test("[T1] spawnFn resolves {stdout, stderr, exitCode, signal} from a real child", async () => {
    const out = await spawnFn(["sh", "-c", 'printf "hello"; printf "warn" 1>&2'], hostEnv(), CWD, {
      signal: freshSignal(),
      deadline: 10_000,
    });
    expect(out.stdout).toBe("hello");
    expect(out.stderr).toBe("warn");
    expect(out.exitCode).toBe(0);
    expect(out.signal).toBeNull();
    expect(out.outcome).toBe("exited");
  });

  test.each([150, 2500])(
    "[T3] cancelGraceMs %dms is honored — abort escalates at the host grace, not PENUMBRA_CANCEL_GRACE_S",
    async (graceMs) => {
      const controller = new AbortController();
      const t0 = Date.now();
      const promise = spawnFn(
        ["sh", "-c", 'trap "" TERM; while :; do sleep 1; done'],
        hostEnv(),
        CWD,
        { signal: controller.signal, deadline: 60_000 },
        { timeoutMs: 30_000, cancelGraceMs: graceMs },
      );
      setTimeout(() => {
        controller.abort();
      }, 40);
      const out = await promise;
      const elapsed = Date.now() - t0;
      expect(out.outcome).toBe("cancelled");
      expect(out.signal).toBe("SIGKILL");
      expect(elapsed).toBeGreaterThanOrEqual(graceMs - 80);
      expect(elapsed).toBeLessThan(graceMs + 2_000);
    },
  );

  test.each([150, 600])(
    "[T4] watchdog fires at min(binding timeoutMs, deadline)=%dms — PENUMBRA_DISPATCH_TIMEOUT_S inert",
    async (deadline) => {
      const t0 = Date.now();
      const out = await spawnFn(["sleep", "30"], hostEnv(), CWD, {
        signal: freshSignal(),
        deadline,
      });
      const elapsed = Date.now() - t0;
      expect(out.outcome).toBe("watchdog");
      expect(out.signal).toBe("SIGKILL");
      expect(elapsed).toBeGreaterThanOrEqual(deadline - 50);
      expect(elapsed).toBeLessThan(deadline + 2_000);
    },
  );

  test("[T6] cancel resolves the exit record only after the whole group is gone", async () => {
    const controller = new AbortController();
    const promise = spawnFn(
      ["sh", "-c", '(trap "" TERM; exec sleep 30 >/dev/null 2>&1 </dev/null) & wait'],
      hostEnv(),
      CWD,
      { signal: controller.signal, deadline: 60_000 },
      { timeoutMs: 30_000, cancelGraceMs: 300 },
    );
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    controller.abort();
    const out = await promise;
    const elapsed = Date.now() - t0;
    expect(out.outcome).toBe("cancelled");
    // The detached descendant ignores TERM; only the grace-expired SIGKILL frees the group.
    expect(elapsed).toBeGreaterThanOrEqual(300 - 50);
    expect(elapsed).toBeLessThan(300 + 2_000);
  });

  test("[T7] warm pool deposit/acquire works with PENUMBRA_WARM_PREWARM_CAP=0 in the env", () => {
    const pool = createPool();
    try {
      const env = hostEnv({ INFRA_MARKER: "t7" });
      const spec = acpSpecFor(env, CWD);
      const handle = fakeHandle();
      expect(pool.deposit(spec, { handle, client: {} })).not.toBeNull();
      expect(pool.acquire(spec)?.handle).toBe(handle);
      expect(pool.acquire(spec)).toBeNull();
    } finally {
      pool.shutdown();
    }
  });
});

describe("infra-host ACP wire", () => {
  test("[ACP-CLIENTINFO] the wire initialize carries infra-host-smoke clientInfo verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-acp-log-"));
    const logPath = join(dir, "wire.log");
    try {
      const booted = await bootAcpSession(FAKE_ACP, hostEnv(), CWD, {
        signal: freshSignal(),
        logPath,
      });
      try {
        expect(booted.session.sessionId).toBe("fake-session-1");
      } finally {
        booted.handle.kill();
        await booted.handle.exited;
      }
      const wire = readFileSync(logPath, "utf8");
      const initLine = wire.split("\n").find((line) => line.includes('"method":"initialize"'));
      expect(initLine).toBeDefined();
      const init = JSON.parse(initLine ?? "{}") as {
        params?: { clientInfo?: unknown; clientCapabilities?: unknown; protocolVersion?: unknown };
      };
      expect(init.params?.clientInfo).toEqual({ name: "infra-host-smoke", version: "0.0.1" });
      expect(init.params?.clientCapabilities).toEqual(ACP_CLIENT_CAPABILITIES);
      expect(init.params?.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[ACP-ENVKEYS] the child env holds exactly the sorted allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-acp-env-"));
    const logPath = join(dir, "wire.log");
    try {
      const env = hostEnv({ INFRA_MARKER: "envprobe", SHAREDLIB6_LEAK: "must-not-cross" });
      const booted = await bootAcpSession(FAKE_ACP, env, CWD, {
        signal: freshSignal(),
        echoEnv: true,
        logPath,
      });
      try {
        expect(booted.session.sessionId).toBe("fake-session-1");
      } finally {
        booted.handle.kill();
        await booted.handle.exited;
      }
      // The fixture echoes process.env keys on the initialize response _meta,
      // which the wire log records verbatim.
      const envLine = readFileSync(logPath, "utf8")
        .split("\n")
        .find((line) => line.includes('"envKeys"'));
      expect(envLine).toBeDefined();
      const response = JSON.parse(envLine ?? "{}") as {
        result?: { _meta?: { envKeys?: string[] } };
      };
      // Expected child env = allowlisted host env + the probe vars the host set.
      const expected = Object.keys(
        buildChildEnv({ ...env, FAKE_ACP_ECHO_ENV: "1", FAKE_ACP_LOG: logPath }),
      ).sort();
      expect(response.result?._meta?.envKeys).toEqual(expected);
      expect(response.result?._meta?.envKeys).not.toContain("SHAREDLIB6_LEAK");
      expect(response.result?._meta?.envKeys).not.toContain("PENUMBRA_CANCEL_GRACE_S");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[B6] a full boot completes initialize → session/new → session/prompt", async () => {
    const booted = await bootAcpSession(FAKE_ACP, hostEnv(), CWD, { signal: freshSignal() });
    try {
      const promptResult = (await booted.client.request("session/prompt", {
        sessionId: booted.session.sessionId,
        prompt: [{ type: "text", text: "ping" }],
      })) as { stopReason?: string };
      expect(promptResult.stopReason).toBe("end_turn");
    } finally {
      booted.handle.kill();
      await booted.handle.exited;
    }
  });
});

describe("infra-host permission surface", () => {
  function seededContext(): StdioAcpPermissionContext {
    const context = new StdioAcpPermissionContext();
    context.activate("s-1");
    context.observe("s-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "fake/tool",
      input: { command: "x" },
    });
    return context;
  }

  const WIRE_REQUEST = {
    sessionId: "s-1",
    toolCall: { toolCallId: "tool-1" },
    options: DENY_OPTIONS,
  };

  test("[PERM-DENY] a request with no decide callback is cancelled without deciding", async () => {
    const result = await primitives.handleStdioAcpPermissionRequest(
      unhandledHost(freshSignal()),
      seededContext(),
      WIRE_REQUEST,
    );
    expect(result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("[PERM-DENY] the deny-all class host selects reject_once without logging a failure", async () => {
    const warns: string[] = [];
    const host = new DenyAllPermissionHost(freshSignal(), {
      warn: (msg) => {
        warns.push(msg);
      },
    });
    const result = await primitives.handleStdioAcpPermissionRequest(
      host,
      seededContext(),
      WIRE_REQUEST,
    );
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    // A bound decide resolves cleanly — a warning here means decide was invoked unbound.
    expect(warns).toEqual([]);
  });

  test("[PERM] denyAllPermission wires the class host through the packed handler", async () => {
    const result = await denyAllPermission(freshSignal(), seededContext(), WIRE_REQUEST);
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });
});

describe("infra-host credential scoping", () => {
  test("[SCOPE-2] two credential scopes pin two distinct child processes", async () => {
    const envA = hostEnv({ INFRA_MARKER: "tenant-a" });
    const envB = hostEnv({ INFRA_MARKER: "tenant-b" });
    const scopeA = credentialScopeFor(envA);
    const scopeB = credentialScopeFor(envB);
    expect(scopeA).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeB).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeA).not.toBe(scopeB);
    expect(poolKeyOf(envA, CWD)).not.toBe(poolKeyOf(envB, CWD));

    const a = await bootAcpSession(FAKE_ACP, envA, CWD, { signal: freshSignal() });
    const b = await bootAcpSession(FAKE_ACP, envB, CWD, { signal: freshSignal() });
    try {
      expect(a.handle.pid).toBeDefined();
      expect(b.handle.pid).toBeDefined();
      expect(a.handle.pid).not.toBe(b.handle.pid);

      const pool = createPool();
      try {
        const specA = acpSpecFor(envA, CWD);
        const specB = acpSpecFor(envB, CWD);
        const handle = fakeHandle();
        expect(pool.deposit(specA, { handle, client: {} })).not.toBeNull();
        expect(pool.acquire(specB)).toBeNull();
        expect(pool.acquire(specA)?.handle).toBe(handle);
      } finally {
        pool.shutdown();
      }
    } finally {
      a.handle.kill();
      b.handle.kill();
      await a.handle.exited;
      await b.handle.exited;
    }
  });
});

describe("infra-host transport + exit surfaces", () => {
  test("[B8] a request on a closed transport rejects AcpTransportClosedError", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new primitives.StdioAcpClient({ stdin, stdout });
    stdout.destroy();
    await new Promise((r) => setTimeout(r, 20));
    await expect(client.request("session/new", {})).rejects.toBeInstanceOf(
      primitives.AcpTransportClosedError,
    );
  });

  test("[PARTIAL-NONZERO] partial stdout survives a non-zero exit", async () => {
    const out = await spawnFn(
      ["sh", "-c", 'printf "chunk1"; sleep 0.05; printf "chunk2"; exit 3'],
      hostEnv(),
      CWD,
      { signal: freshSignal(), deadline: 10_000 },
    );
    expect(out.exitCode).toBe(3);
    expect(out.outcome).toBe("exited");
    expect(out.stdout).toBe("chunk1chunk2");
  });

  test("[ERROR-THEN-EXIT] stderr bytes then a failing exit are both captured", async () => {
    const out = await spawnFn(["sh", "-c", 'printf "diag-line" 1>&2; exit 7'], hostEnv(), CWD, {
      signal: freshSignal(),
      deadline: 10_000,
    });
    expect(out.exitCode).toBe(7);
    expect(out.stderr).toBe("diag-line");
  });

  test("[T1] spawnFnLines streams complete lines in order", async () => {
    const lines: [string, string][] = [];
    const out = await spawnFnLines(
      ["sh", "-c", 'printf "one\\ntwo\\n"; sleep 0.05; printf "three\\n"'],
      hostEnv(),
      CWD,
      { signal: freshSignal(), deadline: 10_000 },
      (line, stream) => {
        lines.push([stream, line]);
      },
    );
    expect(out.exitCode).toBe(0);
    expect(lines.map(([, line]) => line)).toEqual(["one", "two", "three"]);
  });

  test("[GUARD] importing @penumbra/core resolves to the poison stub, never the workspace", async () => {
    await expect(import("@penumbra/core")).rejects.toThrow(/resolution-guard/);
  });
});
