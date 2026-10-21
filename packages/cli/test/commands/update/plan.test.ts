import { describe, expect, test } from "bun:test";

import { planMove, planRecovery, stepLabel } from "@src/commands/update/apply.js";
import { lastHistoryFrom } from "@src/commands/update/history.js";
import { parseUpdateArgs } from "@src/commands/update/options.js";
import { userUnitsInCgroup } from "@src/commands/update/self-safety.js";
import { markerNotes } from "@src/commands/update/verify.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("planMove", () => {
  test("systemd apply with dependency changes", () => {
    expect(
      planMove({ mode: "apply", from: A, to: B, depsChanged: true, canFreeze: true }).map(
        stepLabel,
      ),
    ).toEqual([
      "wait-idle",
      "freeze",
      `record "apply from=${A} to=${B}"`,
      `fast-forward ${B.slice(0, 12)}`,
      "install",
      "restart",
      `verify ${B.slice(0, 12)}`,
    ]);
  });

  test("launchd rollback re-checks idleness before the restart and resets", () => {
    const steps = planMove({
      mode: "rollback",
      from: B,
      to: A,
      depsChanged: false,
      canFreeze: false,
    });
    expect(steps.map((s) => s.kind)).toEqual([
      "wait-idle",
      "record",
      "move",
      "wait-idle",
      "restart",
      "verify",
    ]);
    expect(steps[0]).toEqual({ kind: "wait-idle", requireDaemon: false });
    expect(steps[2]).toEqual({ kind: "move", how: "reset", to: A });
  });
});

describe("planRecovery", () => {
  const base = { frozen: false, installRan: false, restartAttempted: false };

  test("after a failed verification: stop the new worker, reset, reinstall, restart, verify", () => {
    const steps = planRecovery({
      good: A,
      head: B,
      state: { ...base, installRan: true, restartAttempted: true },
      canFreeze: true,
    });
    expect(steps.map((s) => s.kind)).toEqual(["freeze", "move", "install", "restart", "verify"]);
  });

  test("nothing moved and the worker is frozen: only bring the worker back", () => {
    const steps = planRecovery({
      good: A,
      head: A,
      state: { ...base, frozen: true },
      canFreeze: true,
    });
    expect(steps).toEqual([
      { kind: "unfreeze" },
      { kind: "verify", expect: A, restarted: "worker" },
    ]);
  });

  test("nothing happened: nothing to do", () => {
    expect(planRecovery({ good: A, head: A, state: base, canFreeze: true })).toEqual([]);
  });

  test("moved but bun never ran: reset and restart without reinstalling", () => {
    const steps = planRecovery({
      good: A,
      head: B,
      state: { ...base, frozen: true },
      canFreeze: true,
    });
    expect(steps.map((s) => s.kind)).toEqual(["move", "restart", "verify"]);
  });
});

describe("parseUpdateArgs", () => {
  test("defaults come from the environment, flags override", () => {
    const parsed = parseUpdateArgs(
      ["--apply", "--worker-unit", "pw.service"],
      { PENUMBRA_UPDATE_DAEMON_UNIT: "pd.service" },
      "/cwd",
    );
    expect(parsed).toEqual({
      ok: true,
      options: {
        mode: "apply",
        ref: "origin/main",
        rollbackSha: null,
        allowRedCi: false,
        waitIdleS: 900,
        verifyTimeoutS: 120,
        json: false,
        repo: null,
        serviceManager: "auto",
        daemonUnit: "pd.service",
        workerUnit: "pw.service",
        daemonLabel: "dev.penumbra.daemon",
        workerLabel: "dev.penumbra.worker",
      },
    });
  });

  test("--rollback takes an optional sha; --repo resolves against cwd", () => {
    const parsed = parseUpdateArgs(
      ["--rollback", "abc1234", "--repo", "../pen", "--json"],
      {},
      "/home/op/x",
    );
    expect(parsed).toMatchObject({
      ok: true,
      options: { mode: "rollback", rollbackSha: "abc1234", repo: "/home/op/pen", json: true },
    });
    expect(parseUpdateArgs(["--rollback", "--json"], {}, "/").ok).toBe(true);
  });

  test("rejects bad input", () => {
    expect(parseUpdateArgs(["--wait-idle", "-1"], {}, "/")).toEqual({
      ok: false,
      error: "--wait-idle must be a non-negative integer (got -1)",
    });
    expect(parseUpdateArgs(["--ref"], {}, "/")).toEqual({
      ok: false,
      error: "--ref requires a value",
    });
    expect(parseUpdateArgs(["--daemon-unit", "x y.service"], {}, "/").ok).toBe(false);
    expect(parseUpdateArgs(["--service-manager", "runit"], {}, "/").ok).toBe(false);
    expect(parseUpdateArgs([], { PENUMBRA_UPDATE_SERVICE_MANAGER: "runit" }, "/").ok).toBe(false);
    expect(parseUpdateArgs(["-h"], {}, "/")).toEqual({ ok: "help" });
  });
});

describe("history", () => {
  test("rollback target is the last from= (reference script format too)", () => {
    const text = [
      `2026-10-21T10:00:00-04:00 from=${A} to=${B}`,
      `2026-10-21T10:01:00-04:00 ok bbbbbbbb`,
      `2026-10-21T11:00:00.000Z rollback from=${B} to=${A}`,
    ].join("\n");
    expect(lastHistoryFrom(text)).toBe(B);
    expect(lastHistoryFrom("")).toBeNull();
    expect(lastHistoryFrom("from=abc")).toBeNull();
  });
});

describe("userUnitsInCgroup", () => {
  test("lists user-manager units on the cgroup path", () => {
    expect(
      userUnitsInCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-worker.service\n",
        1000,
      ),
    ).toEqual(["penumbra-worker.service"]);
    expect(userUnitsInCgroup("0::/system.slice/penumbra-worker.service\n", 1000)).toEqual([]);
    expect(userUnitsInCgroup("", 1000)).toEqual([]);
  });
});

describe("markerNotes", () => {
  test("surfaces scope, admission and error-level lines", () => {
    const notes = markerNotes(
      {
        daemon: { source: { kind: "file", path: "d" }, cursor: { kind: "offset", value: 0 } },
        worker: {
          source: { kind: "none", reason: "StandardOutput=null" },
          cursor: { kind: "since", value: 0 },
        },
      },
      {
        daemon:
          '{"level":40,"msg":"job resource scopes unavailable; running jobs without a memory cap"}\n',
        worker:
          '{"level":30,"admit_min_gib":3.2,"msg":"job memory admission floor"}\n{"level":50,"msg":"boom"}\n',
      },
    );
    expect(notes).toEqual([
      "worker log not readable (StandardOutput=null)",
      "daemon: WARNING job resource scopes unavailable",
      "worker: job memory admission floor 3.2 GiB",
      "WARNING 1 error-level worker log line(s) since the restart",
    ]);
  });
});
