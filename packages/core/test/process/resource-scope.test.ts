import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import {
  buildResourceScopeArgv,
  detectResourceScopeHost,
  isResourceKill,
  isResourceScopeLaunchFailure,
  parseOwnUserUnit,
  primeResourceScope,
  resetResourceScopeForTest,
  resolveResourceScopeConfig,
  type ResourceScopeConfig,
  type ResourceScopeHost,
  wrapResourceScopeArgv,
} from "@src/process/resource-scope.js";

const ON: ResourceScopeConfig = {
  mode: "on",
  memoryHigh: "12G",
  memoryMax: "16G",
  swapMax: "1G",
  oomScoreAdj: 900,
};

const HOST: ResourceScopeHost = {
  systemdRun: "/usr/bin/systemd-run",
  envBin: "/usr/bin/env",
  choom: "/usr/bin/choom",
  runtimeDir: "/run/user/1000",
  bindUnit: "penumbra-worker.service",
};

const SCOPE_UNIT_RE = /^--unit=penumbra-terminal-[0-9a-f]{8}$/;
// A child env that already reaches the user manager, so no env prefix is added.
const USER_ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };

afterEach(() => {
  resetResourceScopeForTest();
});

function splitAtSeparator(argv: string[]): { outer: string[]; inner: string[] } {
  const idx = argv.indexOf("--");
  return { outer: argv.slice(0, idx), inner: argv.slice(idx + 1) };
}

describe("resolveResourceScopeConfig", () => {
  test("defaults to auto with the 12G/16G/1G caps and oom_score_adj 900", () => {
    expect(resolveResourceScopeConfig({})).toEqual({
      mode: "auto",
      memoryHigh: "12G",
      memoryMax: "16G",
      swapMax: "1G",
      oomScoreAdj: 900,
    });
  });

  test("reads operator overrides", () => {
    expect(
      resolveResourceScopeConfig({
        PENUMBRA_JOB_SCOPE: "on",
        PENUMBRA_JOB_MEMORY_HIGH: "6G",
        PENUMBRA_JOB_MEMORY_MAX: "8G",
        PENUMBRA_JOB_SWAP_MAX: "0",
        PENUMBRA_JOB_OOM_SCORE_ADJ: "500",
      }),
    ).toEqual({ mode: "on", memoryHigh: "6G", memoryMax: "8G", swapMax: "0", oomScoreAdj: 500 });
  });

  test("rejects a size systemd would not accept", () => {
    expect(() => resolveResourceScopeConfig({ PENUMBRA_JOB_MEMORY_MAX: "lots" })).toThrow();
  });
});

describe("wrapResourceScopeArgv", () => {
  test("off returns the argv unchanged", () => {
    expect(
      wrapResourceScopeArgv(["bun", "test"], { config: { ...ON, mode: "off" }, host: HOST }),
    ).toEqual(["bun", "test"]);
  });

  test("an unavailable host falls back to the bare argv", () => {
    expect(wrapResourceScopeArgv(["bun", "test"], { config: ON, host: null })).toEqual([
      "bun",
      "test",
    ]);
  });

  test("on wraps the argv in a capped, lifetime-bound user scope with choom inside", () => {
    const argv = wrapResourceScopeArgv(["bun", "test", "a b"], {
      config: ON,
      host: HOST,
      label: "terminal",
      childEnv: USER_ENV,
    });
    const { outer, inner } = splitAtSeparator(argv);
    expect(outer.slice(0, 5)).toEqual([
      "/usr/bin/systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
    ]);
    expect(outer[5]).toMatch(SCOPE_UNIT_RE);
    expect(outer.slice(6)).toEqual([
      "--description=penumbra job (terminal)",
      "-p",
      "MemoryHigh=12G",
      "-p",
      "MemoryMax=16G",
      "-p",
      "MemorySwapMax=1G",
      "-p",
      "BindsTo=penumbra-worker.service",
      "-p",
      "StopPropagatedFrom=penumbra-worker.service",
    ]);
    expect(inner).toEqual(["/usr/bin/choom", "-n", "900", "--", "bun", "test", "a b"]);
  });

  test("hands XDG_RUNTIME_DIR to systemd-run only when the child env lacks it", () => {
    const argv = wrapResourceScopeArgv(["echo", "hi"], {
      config: ON,
      host: HOST,
      childEnv: { PATH: "/usr/bin:/bin", HOME: "/wt" },
    });
    expect(argv.slice(0, 3)).toEqual([
      "/usr/bin/env",
      "XDG_RUNTIME_DIR=/run/user/1000",
      "/usr/bin/systemd-run",
    ]);
    expect(splitAtSeparator(argv).inner).toEqual([
      "/usr/bin/env",
      "-u",
      "XDG_RUNTIME_DIR",
      "/usr/bin/choom",
      "-n",
      "900",
      "--",
      "echo",
      "hi",
    ]);
  });

  test("leaves the env alone when the child already reaches the user manager", () => {
    const argv = wrapResourceScopeArgv(["echo"], {
      config: ON,
      host: HOST,
      childEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    });
    expect(argv[0]).toBe("/usr/bin/systemd-run");
    expect(splitAtSeparator(argv).inner[0]).toBe("/usr/bin/choom");
  });

  test("without choom (or with oom adjust 0) a trailing env keeps exit 127 for missing commands", () => {
    for (const [host, config] of [
      [{ ...HOST, choom: null }, ON],
      [HOST, { ...ON, oomScoreAdj: 0 }],
    ] as const) {
      expect(splitAtSeparator(buildResourceScopeArgv(["x"], host, config)).inner).toEqual([
        "/usr/bin/env",
        "x",
      ]);
    }
  });

  test("no lifetime binding when the caller is not a user-manager unit", () => {
    const argv = buildResourceScopeArgv(["x"], { ...HOST, bindUnit: null }, ON);
    expect(argv.some((a) => a.startsWith("BindsTo="))).toBe(false);
    expect(argv.some((a) => a.startsWith("StopPropagatedFrom="))).toBe(false);
  });

  test("composes with sandbox-exec: the scope stays outermost", () => {
    const sandboxed = ["/usr/bin/sandbox-exec", "-p", "(version 1)", "bash", "-c", "true"];
    const argv = wrapResourceScopeArgv(sandboxed, { config: ON, host: HOST, childEnv: USER_ENV });
    expect(argv[0]).toBe("/usr/bin/systemd-run");
    expect(splitAtSeparator(argv).inner.slice(4)).toEqual(sandboxed);
  });
});

describe("detectResourceScopeHost", () => {
  const linuxDeps = {
    platform: "linux" as const,
    env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: 1000,
    exists: (p: string): boolean =>
      ["/usr/bin/systemd-run", "/usr/bin/env", "/run/user/1000/systemd/private"].includes(p),
    readFile: (): string =>
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-worker.service\n",
  };

  test("is unavailable off Linux", () => {
    expect(detectResourceScopeHost({ ...linuxDeps, platform: "darwin" })).toEqual({
      available: false,
      reason: "platform=darwin",
    });
  });

  test("is unavailable without systemd-run", () => {
    const res = detectResourceScopeHost({ ...linuxDeps, exists: () => false });
    expect(res).toEqual({ available: false, reason: "systemd-run not found on PATH" });
  });

  test("is unavailable when the user manager socket is missing", () => {
    const res = detectResourceScopeHost({
      ...linuxDeps,
      exists: (p) => p !== "/run/user/1000/systemd/private",
    });
    expect(res.available).toBe(false);
  });

  test("resolves binaries, runtime dir and the unit to bind to", () => {
    expect(detectResourceScopeHost(linuxDeps)).toEqual({
      available: true,
      host: {
        systemdRun: "/usr/bin/systemd-run",
        envBin: "/usr/bin/env",
        choom: null,
        runtimeDir: "/run/user/1000",
        bindUnit: "penumbra-worker.service",
      },
    });
  });
});

describe("parseOwnUserUnit", () => {
  test("finds the innermost service or scope under the user manager", () => {
    const base = "0::/user.slice/user-1000.slice/user@1000.service";
    expect(parseOwnUserUnit(`${base}/app.slice/penumbra-daemon.service`, 1000)).toBe(
      "penumbra-daemon.service",
    );
    expect(parseOwnUserUnit(`${base}/app.slice/run-u12.scope`, 1000)).toBe("run-u12.scope");
    expect(parseOwnUserUnit(`${base}/app.slice/x.service/payload`, 1000)).toBe("x.service");
  });

  test("ignores units that belong to the system manager", () => {
    expect(parseOwnUserUnit("0::/user.slice/user-1000.slice/session-2.scope", 1000)).toBeNull();
    expect(parseOwnUserUnit("0::/system.slice/penumbra.service", 1000)).toBeNull();
    expect(parseOwnUserUnit("", 1000)).toBeNull();
  });
});

describe("primeResourceScope", () => {
  const deps = {
    platform: "linux" as const,
    env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: 1000,
    exists: (p: string): boolean =>
      ["/usr/bin/systemd-run", "/usr/bin/env", "/run/user/1000/systemd/private"].includes(p),
    readFile: (): string => "",
  };

  test("a passing probe enables scoping for later wraps", async () => {
    const probed: string[][] = [];
    const res = await primeResourceScope({
      config: ON,
      deps,
      spawn: (argv) => {
        probed.push(argv);
        return Promise.resolve({ exitCode: 0, signal: null, stderr: "" });
      },
    });
    expect(res.available).toBe(true);
    expect(probed[0]?.at(-1)).toBe("true");
    expect(wrapResourceScopeArgv(["bun"], { config: ON })).toContain("/usr/bin/systemd-run");
  });

  test("a failing probe (old systemd, unreachable bus) disables scoping", async () => {
    const res = await primeResourceScope({
      config: ON,
      deps,
      spawn: () =>
        Promise.resolve({
          exitCode: 1,
          signal: null,
          stderr: "Unknown assignment: StopPropagatedFrom=x.service\n",
        }),
    });
    expect(res).toMatchObject({ available: false });
    expect(wrapResourceScopeArgv(["bun"], { config: ON })).toEqual(["bun"]);
  });

  test("off skips detection entirely", async () => {
    const res = await primeResourceScope({
      config: { ...ON, mode: "off" },
      deps,
      spawn: () => Promise.reject(new Error("must not probe")),
    });
    expect(res).toEqual({ available: false, reason: "PENUMBRA_JOB_SCOPE=off" });
  });
});

describe("resource kill classification", () => {
  test("a SIGKILL or 137 penumbra did not send is a resource kill", () => {
    expect(isResourceKill({ exitCode: null, signal: "SIGKILL" })).toBe(true);
    expect(isResourceKill({ exitCode: 137, signal: null })).toBe(true);
  });

  test("own kills, other signals and ordinary failures are not", () => {
    expect(isResourceKill({ exitCode: null, signal: "SIGKILL", killedByPenumbra: true })).toBe(
      false,
    );
    expect(isResourceKill({ exitCode: null, signal: "SIGTERM" })).toBe(false);
    expect(isResourceKill({ exitCode: 1, signal: null })).toBe(false);
  });

  test("recognizes systemd-run failing before the job started", () => {
    expect(
      isResourceScopeLaunchFailure("Failed to start transient scope unit: Unit x already exists"),
    ).toBe(true);
    expect(isResourceScopeLaunchFailure("Failed to connect to bus: No medium found")).toBe(true);
    expect(isResourceScopeLaunchFailure("error: expected 1 to be 2")).toBe(false);
  });
});

// Real systemd: only where a user manager is reachable (the Z13 host, not CI).
const realHost = detectResourceScopeHost();
const realTest = realHost.available ? test : test.skip;

function runScoped(
  argv: string[],
  config: ResourceScopeConfig,
): {
  pid: number | undefined;
  done: Promise<{ code: number | null; signal: string | null; out: string }>;
} {
  if (!realHost.available) throw new Error("unreachable");
  const scoped = wrapResourceScopeArgv(argv, { config, host: realHost.host, label: "real-test" });
  const child = spawn(scoped[0] ?? "", scoped.slice(1), {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  return {
    pid: child.pid,
    done: new Promise((resolve) => {
      child.on("close", (code, signal) => {
        resolve({ code, signal, out });
      });
    }),
  };
}

describe("real systemd-run scope", () => {
  const SMALL: ResourceScopeConfig = {
    mode: "on",
    memoryHigh: "48M",
    memoryMax: "64M",
    swapMax: "0",
    oomScoreAdj: 900,
  };

  realTest("execs in place: same pid, in its own capped scope, with the oom adjust", async () => {
    const run = runScoped(
      ["/bin/sh", "-c", 'echo "$$"; cat /proc/self/oom_score_adj; cat /proc/self/cgroup'],
      SMALL,
    );
    const res = await run.done;
    const [pid, oom, cgroup] = res.out.trim().split("\n");
    expect(res.code).toBe(0);
    expect(Number(pid)).toBe(run.pid ?? -1);
    if (realHost.available && realHost.host.choom) expect(oom).toBe("900");
    expect(cgroup).toMatch(/\/penumbra-real-test-[0-9a-f]{8}\.scope$/);
  });

  realTest("a process-group kill reaches the scoped job", async () => {
    const run = runScoped(["sleep", "30"], SMALL);
    await Bun.sleep(300);
    process.kill(-(run.pid ?? 0), "SIGTERM");
    const res = await run.done;
    expect(res.signal).toBe("SIGTERM");
  });

  realTest(
    "going over MemoryMax kills the job inside its scope as a resource kill",
    async () => {
      // tail buffers /dev/zero (no newlines) until the 64M scope OOM-kills it;
      // no MemoryHigh, so reclaim throttling cannot stall it short of the cap.
      const run = runScoped(["tail", "/dev/zero"], { ...SMALL, memoryHigh: "infinity" });
      const res = await run.done;
      expect(res.signal).toBe("SIGKILL");
      expect(isResourceKill({ exitCode: res.code, signal: res.signal })).toBe(true);
    },
    30_000,
  );

  realTest("a missing executable still exits 127", async () => {
    const res = await runScoped(["penumbra-no-such-binary-xyzzy"], SMALL).done;
    expect(res.code).toBe(127);
  });
});
