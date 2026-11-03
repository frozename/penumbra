import { describe, expect, test } from "bun:test";

import type { CheckReport, RuntimeReport } from "@src/commands/update/check.js";
import { checkReportJson, formatCheckReport } from "@src/commands/update/format.js";
import type { IdleProbe } from "@src/commands/update/idle.js";
import type {
  DaemonHealth,
  HeavyLockInfo,
  RuntimeState,
  ServiceUnitState,
} from "@src/commands/update/types.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function unit(overrides: Partial<ServiceUnitState> = {}): ServiceUnitState {
  return {
    name: "penumbra-daemon.service",
    loaded: true,
    active: true,
    pid: 4242,
    workingDirectory: "/repo",
    argv: ["/usr/local/bin/bun", "/repo/packages/cli/bin/penumbra.ts", "start"],
    environment: { PATH: "/usr/bin" },
    ...overrides,
  };
}

function runtimeState(): RuntimeState {
  return {
    daemon: unit(),
    worker: unit({
      name: "penumbra-worker.service",
      pid: null,
      active: false,
      environment: { SECRET_TOKEN: "hunter2", HOME: "/home/u" },
    }),
  };
}

function idle(overrides: Partial<IdleProbe> = {}): IdleProbe {
  return {
    idle: true,
    reasons: [],
    dispatched: [],
    approved: null,
    daemonError: null,
    ignoredSessions: [],
    ...overrides,
  };
}

function health(overrides: Partial<DaemonHealth> = {}): DaemonHealth {
  return { ok: true, port: 8787, detail: "GET /health 200", ...overrides };
}

function runtime(overrides: Partial<RuntimeReport> = {}): RuntimeReport {
  return {
    serviceManager: "systemd",
    managerReason: null,
    state: runtimeState(),
    runsFrom: { status: "ok", path: "/repo" },
    health: health(),
    idle: idle(),
    ...overrides,
  };
}

function heavyLock(overrides: Partial<HeavyLockInfo> = {}): HeavyLockInfo {
  return { path: "/home/u/.penumbra/locks/heavy-job.lock", source: "default", ...overrides };
}

function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    repo: "/repo",
    branch: "main",
    ref: "origin/main",
    current: SHA_A,
    target: SHA_B,
    upToDate: false,
    fastForward: true,
    newCommits: 2,
    commits: ["deadbeef feat: one", "cafebabe fix: two"],
    depsChanged: false,
    ci: "success",
    trackedChanges: [],
    runtime: runtime(),
    heavyLock: heavyLock(),
    bun: "/usr/local/bin/bun",
    selfSafety: { ok: true },
    blockers: [],
    applyReady: true,
    ...overrides,
  };
}

describe("formatCheckReport", () => {
  test("header, shas shortened to 12, target, lock and gates", () => {
    const lines = formatCheckReport(report());
    expect(lines[0]).toBe("penumbra update: /repo (branch main)");
    expect(lines).toContain(`  current: ${SHA_A.slice(0, 12)}`);
    expect(lines).toContain(`  target:  origin/main = ${SHA_B.slice(0, 12)}`);
    expect(lines).toContain("  new commits: 2");
    expect(lines).toContain("    deadbeef feat: one");
    expect(lines).toContain("    cafebabe fix: two");
    expect(lines.some((line) => line.includes(SHA_A))).toBe(false);
    expect(lines.some((line) => line.includes(SHA_B))).toBe(false);
    expect(lines).toContain("  dependencies: unchanged");
    expect(lines).toContain("  CI (check workflow) on target: success");
    expect(lines).toContain("  local changes: none");
    expect(lines).toContain(
      `  heavy-job lock: ${heavyLock().path} (default); bun: /usr/local/bin/bun`,
    );
    expect(lines).toContain("  --apply gates: ok");
  });

  test("up-to-date report ends at the lock line, no gates or blockers", () => {
    const lines = formatCheckReport(
      report({
        upToDate: true,
        newCommits: 0,
        commits: [],
        ci: "n/a",
        applyReady: false,
        blockers: ["must not render"],
      }),
    );
    expect(lines).toContain("  already up to date");
    expect(lines.at(-1)).toContain("heavy-job lock:");
    expect(lines.some((line) => line.includes("--apply"))).toBe(false);
    expect(lines.some((line) => line.includes("must not render"))).toBe(false);
  });

  test("detached branch header", () => {
    const [header] = formatCheckReport(report({ branch: null }));
    expect(header).toBe("penumbra update: /repo (branch DETACHED)");
  });

  test("non-fast-forward annotated, no commit list when log is empty", () => {
    const lines = formatCheckReport(
      report({ fastForward: false, newCommits: 0, commits: [], blockers: ["no"] }),
    );
    expect(lines).toContain("  new commits: 0 (NOT a fast-forward)");
  });

  test("collapsed commit list names the hidden count", () => {
    const lines = formatCheckReport(report({ newCommits: 5 }));
    expect(lines).toContain("    … (3 more)");
  });

  test("changed dependencies announce the frozen-lockfile install", () => {
    const lines = formatCheckReport(report({ depsChanged: true }));
    expect(lines).toContain("  dependencies: changed (bun install --frozen-lockfile will run)");
  });

  test("tracked changes counted", () => {
    const lines = formatCheckReport(report({ trackedChanges: [" M a.ts", " M b.ts"] }));
    expect(lines).toContain("  local changes: 2");
  });

  test("blockers rendered as an indented refusal list", () => {
    const lines = formatCheckReport(
      report({ blockers: ["tracked local changes", "daemon is not healthy"], applyReady: false }),
    );
    expect(lines).toContain("  --apply would refuse:");
    expect(lines).toContain("    - tracked local changes");
    expect(lines).toContain("    - daemon is not healthy");
  });

  test("no service manager says none with the detection reason", () => {
    const lines = formatCheckReport(
      report({
        runtime: runtime({
          serviceManager: null,
          managerReason: "no systemd user bus",
          state: null,
          runsFrom: { status: "unknown", path: null },
        }),
      }),
    );
    expect(lines).toContain("  service manager: none (no systemd user bus)");
    expect(lines).toContain("  runs from: unknown (unknown)");
  });

  test("manager line inlines both unit states with pids", () => {
    const lines = formatCheckReport(report());
    expect(lines).toContain(
      "  service manager: systemd (penumbra-daemon.service active pid 4242; penumbra-worker.service inactive)",
    );
    expect(lines).toContain("  runs from: /repo (ok)");
    expect(lines).toContain("  daemon: healthy on :8787 (GET /health 200)");
    expect(lines).toContain("  activity: idle");
  });

  test("unhealthy daemon without a port omits the port suffix", () => {
    const lines = formatCheckReport(
      report({
        runtime: runtime({
          health: health({ ok: false, port: null, detail: "connection refused" }),
        }),
      }),
    );
    expect(lines).toContain("  daemon: UNHEALTHY (connection refused)");
  });

  test("busy activity lists reasons and the approved queue count", () => {
    const lines = formatCheckReport(
      report({
        runtime: runtime({
          idle: idle({
            idle: false,
            reasons: ["1 dispatched handoff", "2 job scopes"],
            approved: 3,
          }),
        }),
      }),
    );
    expect(lines).toContain(
      "  activity: busy: 1 dispatched handoff; 2 job scopes, 3 approved handoff(s) queued",
    );
  });

  test("ignored sessions line when the probe ignored some", () => {
    const lines = formatCheckReport(
      report({
        runtime: runtime({ idle: idle({ ignoredSessions: ["11 bun", "22 node"] }) }),
      }),
    );
    expect(lines).toContain("  ignoring 2 idle agent session(s): 11 bun, 22 node");
  });

  test("daemon error surfaces as unknown in-flight handoffs", () => {
    const lines = formatCheckReport(
      report({
        runtime: runtime({ idle: idle({ idle: false, daemonError: "daemon unreachable" }) }),
      }),
    );
    expect(lines).toContain("  in-flight handoffs unknown: daemon unreachable");
  });

  test("missing flock(1) noted as in-process only", () => {
    const lines = formatCheckReport(report({ heavyLock: heavyLock({ crossProcess: false }) }));
    expect(lines).toContain(
      "  heavy-job lock: /home/u/.penumbra/locks/heavy-job.lock (default); in-process only (no flock(1) found by this CLI): heavy stages do not serialize across processes; bun: /usr/local/bin/bun",
    );
  });

  test("cross-process lock (true or unset) gets no in-process note", () => {
    for (const crossProcess of [true, undefined]) {
      const lines = formatCheckReport(
        report({ heavyLock: heavyLock({ crossProcess, source: "env" }) }),
      );
      expect(lines).toContain(
        "  heavy-job lock: /home/u/.penumbra/locks/heavy-job.lock (env); bun: /usr/local/bin/bun",
      );
    }
  });
});

describe("checkReportJson", () => {
  test("unit environment values are redacted to their keys", () => {
    const json = JSON.stringify(checkReportJson(report()));
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("/usr/bin");

    const out = checkReportJson(report());
    const runtimeOut = out.runtime as Record<string, unknown>;
    const worker = runtimeOut.worker as Record<string, unknown>;
    expect(worker.environment_keys).toEqual(["SECRET_TOKEN", "HOME"]);
    expect("environment" in worker).toBe(false);
    expect(worker.name).toBe("penumbra-worker.service");
    expect(worker.active).toBe(false);
    expect(worker.pid).toBeNull();

    const daemon = runtimeOut.daemon as Record<string, unknown>;
    expect(daemon.environment_keys).toEqual(["PATH"]);
    expect(daemon.environment).toBeUndefined();
  });

  test("null runtime state serializes daemon and worker as null", () => {
    const out = checkReportJson(
      report({
        runtime: runtime({ serviceManager: null, managerReason: "not detected", state: null }),
      }),
    );
    const runtimeOut = out.runtime as Record<string, unknown>;
    expect(runtimeOut.daemon).toBeNull();
    expect(runtimeOut.worker).toBeNull();
    expect(runtimeOut.service_manager).toBeNull();
    expect(runtimeOut.manager_reason).toBe("not detected");
  });

  test("top-level fields survive and runtime is snake_cased summary", () => {
    const out = checkReportJson(report());
    expect(out.repo).toBe("/repo");
    expect(out.current).toBe(SHA_A);
    expect(out.blockers).toEqual([]);
    expect(out.selfSafety).toEqual({ ok: true });
    expect("runtime" in out).toBe(true);
    const runtimeOut = out.runtime as Record<string, unknown>;
    expect(runtimeOut.service_manager).toBe("systemd");
    expect(runtimeOut.runs_from).toEqual({ status: "ok", path: "/repo" });
    expect(runtimeOut.health).toEqual({ ok: true, port: 8787, detail: "GET /health 200" });
    expect(runtimeOut.idle).toEqual(idle());
    expect("state" in runtimeOut).toBe(false);
    expect("runsFrom" in runtimeOut).toBe(false);
    expect("serviceManager" in runtimeOut).toBe(false);
  });
});
