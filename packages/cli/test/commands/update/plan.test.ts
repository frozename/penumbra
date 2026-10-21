import { describe, expect, test } from "bun:test";

import { lastCompletedFrom } from "@src/commands/update/history.js";
import { parseUpdateArgs } from "@src/commands/update/options.js";
import {
  planMove,
  planRecovery,
  type Progress,
  type Step,
  stepLabel,
} from "@src/commands/update/plan.js";
import { userUnitsInCgroup } from "@src/commands/update/self-safety.js";
import { markerNotes } from "@src/commands/update/verify.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const L = "d".repeat(40);

describe("planMove", () => {
  test("systemd apply: idle + heavy-job gate before the freeze, guard before git, idle before restart", () => {
    expect(
      planMove({ mode: "apply", from: A, to: B, depsChanged: true, canFreeze: true }).map(
        stepLabel,
      ),
    ).toEqual([
      "wait-idle + heavy-job gate",
      "freeze",
      `guard HEAD=${A.slice(0, 12)}, clean`,
      `record "apply from=${A} to=${B}"`,
      `fast-forward ${B.slice(0, 12)}`,
      "install",
      "wait-idle",
      "restart",
      `verify ${B.slice(0, 12)}`,
    ]);
  });

  test("launchd rollback: no freeze, reset, idle re-check before the restart", () => {
    const steps = planMove({
      mode: "rollback",
      from: B,
      to: A,
      depsChanged: false,
      canFreeze: false,
    });
    expect(steps.map((s: Step) => s.kind)).toEqual([
      "settle",
      "guard",
      "record",
      "move",
      "wait-idle",
      "restart",
      "verify",
    ]);
    expect(steps[0]).toEqual({ kind: "settle", requireDaemon: false, gate: false });
    expect(steps[3]).toEqual({ kind: "move", how: "reset", to: A });
  });
});

describe("planRecovery", () => {
  const none: Progress = {
    frozen: false,
    movedTo: null,
    installRan: false,
    restartAttempted: false,
  };
  const kinds = (plan: ReturnType<typeof planRecovery>): string[] =>
    plan.kind === "steps" ? plan.steps.map((s: Step) => s.kind) : [plan.kind];

  test("after a failed verification: stop the new worker, guard, reset, reinstall, idle, restart", () => {
    const plan = planRecovery({
      from: A,
      head: B,
      progress: { frozen: false, movedTo: B, installRan: true, restartAttempted: true },
      canFreeze: true,
    });
    expect(kinds(plan)).toEqual([
      "freeze",
      "guard",
      "move",
      "install",
      "wait-idle",
      "restart",
      "verify",
    ]);
    expect(plan).toMatchObject({ changedBack: true });
  });

  test("nothing moved and the worker is frozen: only bring the worker back, whatever HEAD is", () => {
    const plan = planRecovery({
      from: A,
      head: L,
      progress: { ...none, frozen: true },
      canFreeze: true,
    });
    expect(plan).toEqual({
      kind: "steps",
      steps: [{ kind: "unfreeze" }, { kind: "verify", expect: null, restarted: "worker" }],
      changedBack: false,
    });
  });

  test("nothing happened: nothing to do", () => {
    expect(kinds(planRecovery({ from: A, head: A, progress: none, canFreeze: true }))).toEqual([]);
  });

  test("moved but nothing installed or restarted: reset and unfreeze, never restart", () => {
    const progress = { ...none, frozen: true, movedTo: B };
    expect(kinds(planRecovery({ from: A, head: B, progress, canFreeze: true }))).toEqual([
      "guard",
      "move",
      "unfreeze",
      "verify",
    ]);
    const launchd = { ...none, movedTo: B };
    expect(kinds(planRecovery({ from: A, head: B, progress: launchd, canFreeze: false }))).toEqual([
      "guard",
      "move",
    ]);
  });

  test("HEAD that this run did not produce is left alone", () => {
    const plan = planRecovery({
      from: A,
      head: L,
      progress: { ...none, movedTo: B, installRan: true },
      canFreeze: true,
    });
    expect(plan.kind === "hands-off" ? plan.reason : "").toContain("leaving git untouched");
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
  test("the rollback target is the from= of the last completed move", () => {
    const text = [
      `2026-10-21T10:00:00.000Z apply from=${A} to=${B}`,
      `2026-10-21T10:05:00.000Z ok ${B}`,
      `2026-10-21T11:00:00.000Z apply from=${B} to=${L}`,
      `2026-10-21T11:05:00.000Z rolled-back to=${B}`,
      `2026-10-21T12:00:00.000Z apply from=${B} to=${L}`,
      `2026-10-21T12:00:01.000Z aborted at=${B}`,
    ].join("\n");
    expect(lastCompletedFrom(text)).toBe(A);
    expect(lastCompletedFrom(`${text}\nx rollback from=${B} to=${A}\nx ok ${A}\n`)).toBe(B);
  });

  test("reads the bash penumbra-update format (ok with a short sha)", () => {
    const text = `2026-10-21T10:00:00-04:00 from=${A} to=${B}\n2026-10-21T10:01:00-04:00 ok bbbbbbb\n`;
    expect(lastCompletedFrom(text)).toBe(A);
    expect(lastCompletedFrom(`2026-10-21T10:00:00-04:00 from=${A} to=${B}\n`)).toBeNull();
    expect(lastCompletedFrom("")).toBeNull();
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
