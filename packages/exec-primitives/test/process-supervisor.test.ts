import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import * as lib from "../src/index.ts";

import {
  cleanupDir,
  groupExists,
  hostEnv,
  makeTmpDir,
  markerAbsent,
  sleep,
  startFakeAcp,
  stopFakeAcp,
  requestsTo,
  readWireLog,
} from "./helpers.ts";

describe("[B3] env boundary", () => {
  test("[B3] runProcess passes the host env verbatim and leaks nothing", async () => {
    process.env.SHAREDLIB6_LEAK = "secret";
    const dir = makeTmpDir("env");
    try {
      const result = await lib.runProcess({
        command: "sh",
        args: ["-c", "env"],
        cwd: dir,
        env: hostEnv(dir, { MARK: "1" }),
        signal: new AbortController().signal,
        cancelGraceMs: 200,
        watchdogMs: 10_000,
      });
      expect(result.exit.outcome).toBe("exited");
      expect(result.stdout).toContain("MARK=1");
      expect(result.stdout).toContain(`HOME=${dir}`);
      expect(result.stdout).not.toContain("SHAREDLIB6_LEAK");
    } finally {
      delete process.env.SHAREDLIB6_LEAK;
      cleanupDir(dir);
    }
  });

  test("[B3] startStdioAcpServer child sees exactly the host env keys", async () => {
    const fake = await startFakeAcp("envkeys", { FAKE_ACP_ECHO_ENV: "1" });
    try {
      const result = (await fake.client.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "probe", version: "0.0.0" },
        clientCapabilities: {},
      })) as { _meta?: { envKeys?: string[] } };
      expect(result._meta?.envKeys).toEqual(["FAKE_ACP_ECHO_ENV", "FAKE_ACP_LOG", "HOME", "PATH"]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B3] a missing env throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("env-missing");
    const marker = join(dir, "spawned");
    try {
      await expect(
        lib.runProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.runProcess>[0]),
      ).rejects.toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("[B3] cwd boundary", () => {
  test("[B3] cwd is required and reaches the child verbatim", async () => {
    const dir = makeTmpDir("cwd");
    try {
      const result = await lib.runProcess({
        command: "sh",
        args: ["-c", "pwd -P"],
        cwd: dir,
        env: hostEnv(dir),
        signal: new AbortController().signal,
        cancelGraceMs: 200,
        watchdogMs: 10_000,
      });
      expect(result.stdout.trim()).toBe(dir);
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B3] a missing cwd throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("cwd-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("[B4] cancel grace", () => {
  for (const cancelGraceMs of [300, 2500] as const) {
    test(`[B4] SIGKILL lands inside (graceMs, graceMs+1500) at cancelGraceMs=${String(cancelGraceMs)}`, async () => {
      process.env.PENUMBRA_CANCEL_GRACE_S = "60";
      const dir = makeTmpDir("grace");
      const ac = new AbortController();
      try {
        const proc = lib.superviseProcess({
          command: "sh",
          args: ["-c", 'trap "" TERM; while :; do sleep 1; done'],
          cwd: dir,
          env: hostEnv(dir),
          signal: ac.signal,
          cancelGraceMs,
          watchdogMs: 30_000,
        });
        await sleep(50);
        expect(groupExists(proc.pgid)).toBe(true);

        const t0 = Date.now();
        ac.abort();
        await sleep(cancelGraceMs - 150);
        expect(groupExists(proc.pgid)).toBe(true);

        const exit = await proc.exit;
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(cancelGraceMs + 1500);
        expect(exit.outcome).toBe("cancelled");
        expect(exit.signal).toBe("SIGKILL");
        expect(groupExists(proc.pgid)).toBe(false);
      } finally {
        delete process.env.PENUMBRA_CANCEL_GRACE_S;
        cleanupDir(dir);
      }
    });
  }
});

describe("[B4] watchdog", () => {
  for (const watchdogMs of [400, 2500] as const) {
    test(`[B4] watchdog fires inside (watchdogMs, watchdogMs+1500) at watchdogMs=${String(watchdogMs)}`, async () => {
      process.env.PENUMBRA_DISPATCH_TIMEOUT_S = "60";
      const dir = makeTmpDir("watchdog");
      try {
        const t0 = Date.now();
        const proc = lib.superviseProcess({
          command: "sleep",
          args: ["30"],
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs,
        });
        await sleep(50);
        expect(groupExists(proc.pgid)).toBe(true);
        await sleep(watchdogMs - 150 - 50);
        expect(groupExists(proc.pgid)).toBe(true);

        const exit = await proc.exit;
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(watchdogMs + 1500);
        expect(elapsed).toBeGreaterThanOrEqual(watchdogMs - 150);
        expect(exit.outcome).toBe("watchdog");
        expect(groupExists(proc.pgid)).toBe(false);
      } finally {
        delete process.env.PENUMBRA_DISPATCH_TIMEOUT_S;
        cleanupDir(dir);
      }
    });
  }
});

describe("[B10] required host inputs", () => {
  test("[B10] missing cancelGraceMs throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("grace-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B10] missing watchdogMs throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("watchdog-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B10] missing signal throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("signal-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          env: hostEnv(dir),
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

test("[B10] cancel resolves the exit record only after the whole group is gone", async () => {
  const dir = makeTmpDir("group-gone");
  const ac = new AbortController();
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 1; done) & wait'],
      cwd: dir,
      env: hostEnv(dir),
      signal: ac.signal,
      cancelGraceMs: 300,
      watchdogMs: 30_000,
    });
    await sleep(50);
    expect(groupExists(proc.pgid)).toBe(true);

    const t0 = Date.now();
    ac.abort();
    const exit = await proc.exit;
    const elapsed = Date.now() - t0;

    expect(exit.outcome).toBe("cancelled");
    expect(elapsed).toBeLessThan(300 + 500);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] outputLimitBytes kills the group and marks the record truncated", async () => {
  const dir = makeTmpDir("cap");
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'head -c 1000000 /dev/zero | tr "\\0" a'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
      outputLimitBytes: 65_536,
    });
    const exit = await proc.exit;
    expect(exit.outcome).toBe("output-limit");
    expect(exit.truncated).toBe(true);
    expect(exit.stdoutBytes).toBeGreaterThan(65_536);
    expect(exit.stdoutBytes).toBeLessThanOrEqual(65_536 + 65_536);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] injected timers are fully disarmed by the time exit resolves on every outcome", async () => {
  const dir = makeTmpDir("timers");
  try {
    for (const scenario of [
      "exited",
      "cancelled",
      "watchdog",
      "output-limit",
      "spawn-error",
    ] as const) {
      let armed = 0;
      const timers = {
        setTimeout: (fn: () => void, ms: number): unknown => {
          armed += 1;
          return setTimeout(() => {
            armed -= 1;
            fn();
          }, ms);
        },
        clearTimeout: (handle: unknown): void => {
          clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
          armed -= 1;
        },
      };
      const ac = new AbortController();
      const base = {
        cwd: dir,
        env: hostEnv(dir),
        signal: ac.signal,
        cancelGraceMs: 100,
        watchdogMs: 10_000,
        timers,
      };
      let exit: lib.ExitRecord;
      if (scenario === "exited") {
        exit = await lib.superviseProcess({ ...base, command: "sh", args: ["-c", "echo hi"] }).exit;
      } else if (scenario === "cancelled") {
        const proc = lib.superviseProcess({ ...base, command: "sleep", args: ["30"] });
        ac.abort();
        exit = await proc.exit;
      } else if (scenario === "watchdog") {
        exit = await lib.superviseProcess({
          ...base,
          command: "sleep",
          args: ["30"],
          watchdogMs: 150,
        }).exit;
      } else if (scenario === "output-limit") {
        exit = await lib.superviseProcess({
          ...base,
          command: "sh",
          args: ["-c", 'head -c 500000 /dev/zero | tr "\\0" b'],
          outputLimitBytes: 4096,
        }).exit;
      } else {
        exit = await lib.superviseProcess({
          ...base,
          command: "/nonexistent/exec-primitives-probe",
          args: [],
        }).exit;
      }
      expect(exit.outcome).toBe(scenario);
      expect(armed).toBe(0);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] runProcess resolves on non-zero exit without throwing", async () => {
  const dir = makeTmpDir("nonzero");
  try {
    const result = await lib.runProcess({
      command: "sh",
      args: ["-c", "echo out; echo err 1>&2; exit 7"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
    });
    expect(result.exit.outcome).toBe("exited");
    expect(result.exit.code).toBe(7);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] the wire log of a real ACP session round-trips through superviseProcess pipes", async () => {
  const fake = await startFakeAcp("wire");
  try {
    const result = (await fake.client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "probe", version: "0.0.0" },
      clientCapabilities: {},
    })) as { authMethods?: unknown[] };
    expect(result.authMethods).toEqual([{ id: "env", type: "env_var" }]);
    const requests = requestsTo(fake.logPath, "initialize");
    expect(requests).toHaveLength(1);
    expect(readWireLog(fake.logPath).length).toBeGreaterThanOrEqual(2);
  } finally {
    await stopFakeAcp(fake);
  }
});
