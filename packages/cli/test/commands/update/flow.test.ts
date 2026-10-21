import { describe, expect, test } from "bun:test";

import { runUpdateCommand } from "@src/commands/update/index.js";

import { HISTORY, SHA_A, SHA_B, SHA_C, STORAGE, World } from "./_world.js";

async function run(world: World, args: string[]): Promise<number> {
  return await runUpdateCommand(args, STORAGE, world.deps());
}

describe("penumbra update --check", () => {
  test("reports the move and the runtime without changing anything", async () => {
    const world = new World();
    world.depsChanged = true;
    world.inFlight = [{ ok: true, dispatched: [], approved: 2 }];

    expect(await run(world, ["--json"])).toBe(0);

    const report = world.json();
    expect(report).toMatchObject({
      mode: "check",
      current: SHA_A,
      target: SHA_B,
      upToDate: false,
      fastForward: true,
      newCommits: 2,
      depsChanged: true,
      ci: "success",
      applyReady: true,
      blockers: [],
      heavyLock: { path: "/home/op/.penumbra/locks/heavy-job.lock", source: "default" },
    });
    expect(report.runtime).toMatchObject({
      service_manager: "systemd",
      runs_from: { status: "ok" },
      health: { ok: true, port: 45787 },
      idle: { idle: true, approved: 2 },
    });
    expect(world.events).toEqual(["fetch origin/main"]);
  });

  test("lists --apply blockers but still exits 0", async () => {
    const world = new World();
    world.ci = "failure";
    world.tracked = [" M packages/core/src/x.ts"];

    expect(await run(world, ["--check"])).toBe(0);

    const text = world.out.join("\n");
    expect(text).toContain("--apply would refuse:");
    expect(text).toContain("target CI is 'failure'");
    expect(text).toContain("tracked local changes");
    expect(world.mutations()).toEqual([]);
  });

  test("takes the heavy-job lock from the worker unit and never prints unit env values", async () => {
    const world = new World();
    world.workerEnv = { PENUMBRA_JOB_HEAVY_LOCK: "/ops/.heavy.lock", SOME_API_KEY: "sk-secret" };

    expect(await run(world, ["--json"])).toBe(0);

    const report = world.json();
    expect(report.heavyLock).toEqual({ path: "/ops/.heavy.lock", source: "worker-unit" });
    expect(JSON.stringify(report)).not.toContain("sk-secret");
    expect(report.runtime).toMatchObject({
      worker: { environment_keys: ["PENUMBRA_JOB_HEAVY_LOCK", "SOME_API_KEY"] },
    });
  });

  test("is up to date when HEAD is the target", async () => {
    const world = new World();
    world.head = SHA_B;
    expect(await run(world, [])).toBe(0);
    expect(world.out.join("\n")).toContain("already up to date");
  });
});

describe("penumbra update --apply", () => {
  test("waits idle, freezes the worker, records, fast-forwards, installs, restarts and verifies in order", async () => {
    const world = new World();
    world.depsChanged = true;

    expect(await run(world, ["--apply"])).toBe(0);

    expect(world.mutations()).toEqual([
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "install",
      "restart",
      `history ok ${SHA_B}`,
    ]);
    expect(world.head).toBe(SHA_B);
    expect(
      world.events.slice(world.events.indexOf("gate"), world.events.indexOf("restart")),
    ).toEqual([
      "gate",
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "install",
      "gate released",
    ]);
    expect(world.out.join("\n")).toContain(`done: ${SHA_A.slice(0, 12)} -> ${SHA_B.slice(0, 12)}`);
    expect(world.out.join("\n")).toContain("worker: job memory admission floor 20 GiB");
  });

  test("skips the install when no dependency file changed", async () => {
    const world = new World();
    expect(await run(world, ["--apply", "--json"])).toBe(0);
    expect(world.mutations()).not.toContain("install");
    expect(world.json()).toMatchObject({
      mode: "apply",
      outcome: "updated",
      from: SHA_A,
      to: SHA_B,
    });
  });

  test("launchd has no freeze and re-checks idleness right before the restart", async () => {
    const world = new World();
    world.manager = world.systemd("launchd");
    world.inFlight = [
      { ok: true, dispatched: [], approved: 0 },
      { ok: true, dispatched: [], approved: 0 },
      {
        ok: true,
        dispatched: [{ handoffId: "h-late-claim", agent: "codex", workerId: "w" }],
        approved: 0,
      },
      { ok: true, dispatched: [], approved: 0 },
    ];

    expect(await run(world, ["--apply"])).toBe(0);

    expect(world.mutations()).toEqual([
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "restart",
      `history ok ${SHA_B}`,
    ]);
    expect(world.out.join("\n")).toContain(
      "waiting for idle: 1 dispatched handoff(s): h-late-c (codex)",
    );
  });

  test("refuses a dirty checkout without touching anything", async () => {
    const world = new World();
    world.tracked = [" M AGENTS.md"];
    expect(await run(world, ["--apply"])).toBe(1);
    expect(world.mutations()).toEqual([]);
    expect(world.err.join("\n")).toContain("tracked local changes");
  });

  test("refuses a non-fast-forward target", async () => {
    const world = new World();
    world.head = SHA_C;
    world.refs.set("origin/main", SHA_B);
    world.ancestry.delete(`${SHA_C}>${SHA_B}`);
    expect(await run(world, ["--apply"])).toBe(1);
    expect(world.err.join("\n")).toContain("is not a fast-forward");
    expect(world.mutations()).toEqual([]);
  });

  test("refuses red or unknown CI unless --allow-red-ci", async () => {
    for (const ci of ["failure", "pending", "unknown", "none"]) {
      const world = new World();
      world.ci = ci;
      expect(await run(world, ["--apply"])).toBe(1);
      expect(world.err.join("\n")).toContain(`target CI is '${ci}'`);
      expect(world.mutations()).toEqual([]);
    }
    const world = new World();
    world.ci = "failure";
    expect(await run(world, ["--apply", "--allow-red-ci"])).toBe(0);
    expect(world.head).toBe(SHA_B);
  });

  test("refuses when the daemon is not healthy before the update", async () => {
    const world = new World();
    world.healthy = false;
    expect(await run(world, ["--apply"])).toBe(1);
    expect(world.err.join("\n")).toContain("daemon is not healthy (connection refused)");
  });

  test("refuses when no service manager runs the units, with manual instructions", async () => {
    const world = new World();
    world.manager = null;
    world.managerReason =
      "systemd --user has no penumbra-daemon.service or penumbra-worker.service loaded";
    expect(await run(world, ["--apply"])).toBe(1);
    const text = world.err.join("\n");
    expect(text).toContain("has no penumbra-daemon.service or penumbra-worker.service loaded");
    expect(text).toContain("PENUMBRA_UPDATE_DAEMON_UNIT");
    expect(text).toContain("bun install --frozen-lockfile");
  });

  test("refuses when the service runs from a different checkout", async () => {
    const world = new World();
    world.workingDirectory = "/srv/other-penumbra";
    expect(await run(world, ["--apply"])).toBe(1);
    expect(world.err.join("\n")).toContain("the service runs from /srv/other-penumbra");
  });

  test("waits for in-flight dispatches, then proceeds", async () => {
    const world = new World();
    const busy = {
      ok: true as const,
      dispatched: [{ handoffId: "0123456789", agent: "claude", workerId: "w" }],
      approved: 0,
    };
    world.inFlight = [busy, busy, busy, { ok: true, dispatched: [], approved: 0 }];
    const start = world.now;

    expect(await run(world, ["--apply"])).toBe(0);

    expect(world.now - start).toBeGreaterThanOrEqual(30_000);
    expect(world.out.join("\n")).toContain(
      "waiting for idle: 1 dispatched handoff(s): 01234567 (claude)",
    );
  });

  test("gives up after --wait-idle without freezing or moving", async () => {
    const world = new World();
    world.scopes = ["penumbra-acp-claude-1a2b.scope"];

    expect(await run(world, ["--apply", "--wait-idle", "60"])).toBe(1);

    expect(world.mutations()).toEqual([]);
    expect(world.head).toBe(SHA_A);
    expect(world.err.join("\n")).toContain(
      "still busy after 60s (job scopes running: penumbra-acp-claude-1a2b.scope)",
    );
  });

  test("worker child processes count as busy", async () => {
    const world = new World();
    world.children = ["777 codex"];
    expect(await run(world, ["--apply", "--wait-idle", "0"])).toBe(1);
    expect(world.err.join("\n")).toContain("worker has child processes: 777 codex");
  });

  test("rolls back automatically when the new build fails verification", async () => {
    const world = new World();
    world.depsChanged = true;
    world.bootsOk = (sha: string): boolean => sha !== SHA_B;

    expect(await run(world, ["--apply", "--verify-timeout", "10"])).toBe(3);

    expect(world.mutations()).toEqual([
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "install",
      "restart",
      "freeze",
      "reset a",
      "install",
      "restart",
      `history rolled-back to=${SHA_A}`,
    ]);
    expect(world.head).toBe(SHA_A);
    expect(world.err.join("\n")).toContain(`rolled back to ${SHA_A.slice(0, 12)}`);
  });

  test("a heavy-job gate timeout refuses before the worker is stopped", async () => {
    const world = new World();
    world.depsChanged = true;
    world.gate = { ok: false, detail: "heavy-job lock /l not acquired within 900s" };

    expect(await run(world, ["--apply", "--json"])).toBe(1);

    expect(world.mutations()).toEqual([]);
    expect(world.json()).toMatchObject({
      outcome: "refused",
      failure: {
        step: "wait-idle + heavy-job gate",
        detail: "heavy-job gate: heavy-job lock /l not acquired within 900s",
      },
    });
  });

  test("bun that never started: reset and start the worker, no reinstall or restart", async () => {
    const world = new World();
    world.depsChanged = true;
    world.install = { ok: false, ran: false, detail: "exit 127: bun: not found" };

    expect(await run(world, ["--apply", "--json"])).toBe(1);

    expect(world.mutations()).toEqual([
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "install",
      "reset a",
      "unfreeze",
      `history aborted at=${SHA_A}`,
    ]);
    expect(world.json()).toMatchObject({ outcome: "refused", failure: { step: "install" } });
  });

  test("bun that ran and failed: reset, reinstall, restart once idle", async () => {
    const world = new World();
    world.depsChanged = true;
    world.install = { ok: false, ran: true, detail: "exit 1: lockfile had changes" };
    world.duringInstall = (): void => {
      world.install = { ok: true, ran: true, detail: "installed" };
    };

    expect(await run(world, ["--apply"])).toBe(3);

    expect(world.mutations()).toEqual([
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "install",
      "reset a",
      "install",
      "restart",
      `history rolled-back to=${SHA_A}`,
    ]);
  });

  test("exits 4 when the rollback does not come up either", async () => {
    const world = new World();
    world.bootsOk = (): boolean => false;
    expect(await run(world, ["--apply", "--verify-timeout", "4"])).toBe(4);
    expect(world.files.get(HISTORY)).toContain(`needs-operator head=${SHA_A}`);
    expect(world.err.join("\n")).toContain("runtime needs attention");
  });
});

describe("self-safety", () => {
  test("refuses --apply from inside the worker unit but --check still reports", async () => {
    const world = new World();
    world.cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-worker.service\n";

    expect(await run(world, ["--apply"])).toBe(1);
    const text = world.err.join("\n");
    expect(text).toContain("this process runs inside penumbra-worker.service");
    expect(text).toContain(
      "systemd-run --user --unit penumbra-update --collect -- /usr/bin/bun /srv/penumbra/packages/cli/bin/penumbra.ts update --apply",
    );
    expect(world.mutations()).toEqual([]);

    const check = new World();
    check.cgroup = world.cgroup;
    expect(await run(check, ["--json"])).toBe(0);
    expect(check.json().selfSafety).toMatchObject({ ok: false });
  });

  test("refuses inside a job scope bound to the worker, allows an unbound penumbra-update scope", async () => {
    const world = new World();
    world.cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-acp-codex-9f.scope\n";
    world.bindsTo.set("penumbra-acp-codex-9f.scope", ["penumbra-worker.service"]);
    expect(await run(world, ["--apply"])).toBe(1);
    expect(world.err.join("\n")).toContain(
      "penumbra-acp-codex-9f.scope, which is bound to penumbra-worker.service",
    );

    const ok = new World();
    ok.cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-update.scope\n";
    expect(await run(ok, ["--apply"])).toBe(0);
  });

  test("refuses when the process descends from the worker's main pid", async () => {
    const world = new World();
    world.head = SHA_B;
    world.parents = new Map([
      [4242, 3000],
      [3000, world.workerPid],
    ]);
    expect(await run(world, ["--rollback", SHA_A.slice(0, 7)])).toBe(1);
    expect(world.err.join("\n")).toContain("descends from penumbra-worker.service (pid 200)");
  });
});

describe("penumbra update --rollback", () => {
  test("defaults to the last from= in the history and resets with the same procedure", async () => {
    const world = new World();
    world.head = SHA_C;
    world.refs.set("origin/main", SHA_C);
    world.depsChanged = true;
    world.files.set(
      HISTORY,
      `2026-10-21T10:00:00.000Z apply from=${SHA_A} to=${SHA_B}\n2026-10-21T10:01:00.000Z ok ${SHA_B}\n` +
        `2026-10-21T11:00:00.000Z apply from=${SHA_B} to=${SHA_C}\n2026-10-21T11:01:00.000Z ok ${SHA_C}\n`,
    );

    expect(await run(world, ["--rollback"])).toBe(0);

    expect(world.mutations()).toEqual([
      "freeze",
      `history rollback from=${SHA_C} to=${SHA_B}`,
      "reset b",
      "install",
      "restart",
      `history ok ${SHA_B}`,
    ]);
  });

  test("tolerates an unreachable daemon (a common reason to roll back)", async () => {
    const world = new World();
    world.head = SHA_B;
    world.healthy = false;
    world.inFlight = [{ ok: false, error: "GET /handoffs failed: connection refused" }];
    world.files.set(HISTORY, `x apply from=${SHA_A} to=${SHA_B}\nx ok ${SHA_B}\n`);
    expect(await run(world, ["--rollback"])).toBe(0);
    expect(world.head).toBe(SHA_A);
  });

  test("an apply that was rolled back is not a rollback target", async () => {
    const world = new World();
    world.files.set(HISTORY, `x apply from=${SHA_A} to=${SHA_B}\nx rolled-back to=${SHA_A}\n`);
    expect(await run(world, ["--rollback"])).toBe(1);
    expect(world.err.join("\n")).toContain("no rollback target");
  });

  test("refuses when the target is already checked out", async () => {
    const world = new World();
    world.files.set(HISTORY, `x apply from=${SHA_A} to=${SHA_B}\nx ok ${SHA_B}\n`);
    expect(await run(world, ["--rollback"])).toBe(1);
    expect(world.err.join("\n")).toContain(`already at ${SHA_A.slice(0, 12)}`);
  });

  test("refuses without history or explicit sha", async () => {
    const world = new World();
    expect(await run(world, ["--rollback"])).toBe(1);
    expect(world.err.join("\n")).toContain("no rollback target");
  });

  test("refuses a target that is not on the tracked ref", async () => {
    const world = new World();
    world.head = SHA_B;
    world.ancestry.delete(`${SHA_A}>${SHA_B}`);
    expect(await run(world, ["--rollback", SHA_A])).toBe(1);
    expect(world.err.join("\n")).toContain("is not on origin/main");
    expect(world.mutations()).toEqual([]);
  });

  test("refuses to reset away local commits that are not on the tracked ref", async () => {
    const world = new World();
    world.head = SHA_C;
    world.refs.set("origin/main", SHA_B);
    world.ancestry.delete(`${SHA_C}>${SHA_B}`);
    expect(await run(world, ["--rollback", SHA_A])).toBe(1);
    expect(world.err.join("\n")).toContain(
      `HEAD ${SHA_C.slice(0, 12)} has commits that are not on origin/main`,
    );
    expect(world.mutations()).toEqual([]);
  });

  test("exits 4 when the rolled-back build is unhealthy", async () => {
    const world = new World();
    world.head = SHA_B;
    world.bootsOk = (): boolean => false;
    expect(await run(world, ["--rollback", SHA_A, "--verify-timeout", "2"])).toBe(4);
    expect(world.files.get(HISTORY)).toContain(`needs-operator head=${SHA_A}`);
    expect(world.mutations()).not.toContain("reset b");
  });
});

describe("usage", () => {
  test("--help prints usage; bad flags exit 2", async () => {
    const world = new World();
    expect(await run(world, ["--help"])).toBe(0);
    expect(world.out.join("\n")).toContain("usage: penumbra update");
    expect(await run(world, ["--apply", "--rollback"])).toBe(2);
    expect(await run(world, ["--wait-idle", "soon"])).toBe(2);
    expect(await run(world, ["--bogus"])).toBe(2);
  });
});
