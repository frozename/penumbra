import { describe, expect, test } from "bun:test";

import { runUpdateCommand } from "@src/commands/update/index.js";
import type { InstallGate, InstallResult } from "@src/commands/update/types.js";

import { BUSY, HISTORY, SHA_A, SHA_B, STORAGE, World } from "./_world.js";

const SHA_L = "d".repeat(40);
const IDLE = { ok: true as const, dispatched: [], approved: 0 };

async function run(world: World, args: string[]): Promise<number> {
  return await runUpdateCommand(args, STORAGE, world.deps());
}

describe("a land into the running checkout during the update", () => {
  // Converted from the review repro: dispatch_land squashes into the project root,
  // which for penumbra is the running checkout, while --apply waits for idle.
  test("a commit landed during the idle wait aborts before git is touched", async () => {
    const world = new World();
    world.ancestry.add(`${SHA_A}>${SHA_L}`);
    world.inFlight = [BUSY, BUSY, IDLE];
    world.onPoll = (poll): void => {
      if (poll === 3) world.head = SHA_L;
    };

    expect(await run(world, ["--apply"])).toBe(1);

    expect(world.head).toBe(SHA_L);
    expect(world.mutations()).toEqual(["freeze", "unfreeze"]);
    expect(world.files.get(HISTORY)).toBeUndefined();
    expect(world.err.join("\n")).toContain(
      `HEAD moved to ${SHA_L.slice(0, 12)} (expected ${SHA_A.slice(0, 12)}); a commit landed`,
    );
  });

  test("tracked edits that appear during the wait abort before git is touched", async () => {
    const world = new World();
    world.inFlight = [BUSY, BUSY, IDLE];
    world.onPoll = (poll): void => {
      if (poll === 3) world.tracked = [" M packages/core/src/x.ts"];
    };

    expect(await run(world, ["--apply"])).toBe(1);

    expect(world.head).toBe(SHA_A);
    expect(world.mutations()).toEqual(["freeze", "unfreeze"]);
    expect(world.err.join("\n")).toContain("tracked changes appeared");
  });

  test("a commit landed on top of the new HEAD is never reset away (exit 4, git untouched)", async () => {
    const world = new World();
    world.depsChanged = true;
    world.ancestry.add(`${SHA_B}>${SHA_L}`);
    world.install = { ok: false, ran: true, detail: "exit 1" };
    world.duringInstall = (): void => {
      world.head = SHA_L;
    };

    expect(await run(world, ["--apply", "--json"])).toBe(4);

    expect(world.head).toBe(SHA_L);
    expect(world.mutations()).toEqual([
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "install",
      `history needs-operator head=${SHA_L}`,
      "unfreeze",
    ]);
    const outcome = world.json() as { outcome: string; recovery: { failure: { detail: string } } };
    expect(outcome.outcome).toBe("needs-operator");
    expect(outcome.recovery.failure.detail).toContain("leaving git untouched");
  });

  test("tracked edits before the recovery reset are not discarded", async () => {
    const world = new World();
    world.bootsOk = (sha): boolean => {
      if (sha === SHA_B) world.tracked = [" M AGENTS.md"];
      return sha !== SHA_B;
    };

    expect(await run(world, ["--apply", "--verify-timeout", "2"])).toBe(4);

    expect(world.head).toBe(SHA_B);
    expect(world.mutations()).not.toContain("reset a");
    expect(world.mutations().slice(-3)).toEqual([
      "freeze",
      `history needs-operator head=${SHA_B}`,
      "unfreeze",
    ]);
  });

  test("--rollback re-checks HEAD after the wait", async () => {
    const world = new World();
    world.head = SHA_B;
    world.ancestry.add(`${SHA_B}>${SHA_L}`);
    world.inFlight = [BUSY, BUSY, IDLE];
    world.onPoll = (poll): void => {
      if (poll === 3) world.head = SHA_L;
    };

    expect(await run(world, ["--rollback", SHA_A])).toBe(1);

    expect(world.head).toBe(SHA_L);
    expect(world.mutations()).toEqual(["freeze", "unfreeze"]);
  });
});

describe("the frozen window", () => {
  // Converted from the review repro: launchd's last idle check times out after the move.
  test("launchd: a timed-out idle check before the restart resets without restarting", async () => {
    const world = new World();
    world.manager = world.systemd("launchd");
    world.inFlight = [IDLE, IDLE, BUSY];

    expect(await run(world, ["--apply", "--wait-idle", "30"])).toBe(1);

    expect(world.mutations()).toEqual([
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "reset a",
      `history aborted at=${SHA_A}`,
    ]);
    expect(world.head).toBe(SHA_A);
  });

  test("systemd: waits for daemon-bound job scopes before restarting the daemon", async () => {
    const world = new World();
    world.onPoll = (poll): void => {
      world.scopes = poll === 3 ? ["penumbra-fs-exec-1a2b.scope"] : [];
    };

    expect(await run(world, ["--apply"])).toBe(0);

    expect(world.out.join("\n")).toContain(
      "waiting for idle: job scopes running: penumbra-fs-exec-1a2b.scope",
    );
    expect(world.mutations()).toEqual([
      "freeze",
      `history apply from=${SHA_A} to=${SHA_B}`,
      "ff b",
      "restart",
      `history ok ${SHA_B}`,
    ]);
  });

  test("busy again after taking the heavy-job gate: release it and wait again", async () => {
    const world = new World();
    world.depsChanged = true;
    world.inFlight = [IDLE, IDLE, BUSY, IDLE];

    expect(await run(world, ["--apply"])).toBe(0);

    expect(world.events.filter((e) => e.startsWith("gate") || e === "freeze")).toEqual([
      "gate",
      "gate released",
      "gate",
      "freeze",
      "gate released",
    ]);
  });

  test("a failed --rollback still starts the worker again", async () => {
    const world = new World();
    world.head = SHA_B;
    world.onPoll = (poll): void => {
      world.scopes = poll >= 3 ? ["penumbra-shell-session-9.scope"] : [];
    };

    expect(await run(world, ["--rollback", SHA_A, "--wait-idle", "15"])).toBe(1);

    expect(world.mutations()).toEqual([
      "freeze",
      `history rollback from=${SHA_B} to=${SHA_A}`,
      "reset a",
      "reset b",
      "unfreeze",
      `history aborted at=${SHA_B}`,
    ]);
    expect(world.workerActive).toBe(true);
  });
});

describe("install errors", () => {
  test("an install that throws counts as having touched node_modules", async () => {
    const world = new World();
    world.depsChanged = true;
    const deps = world.deps();
    let runs = 0;
    deps.ports = {
      ...deps.ports,
      install: {
        acquire: (): Promise<InstallGate> =>
          Promise.resolve({ ok: true, lease: { release: () => Promise.resolve() } }),
        run: (): Promise<InstallResult> => {
          runs += 1;
          world.events.push("install");
          return runs === 1
            ? Promise.reject(new Error("boom"))
            : Promise.resolve({ ok: true, ran: true, detail: "installed" });
        },
      },
    };

    expect(await runUpdateCommand(["--apply"], STORAGE, deps)).toBe(3);

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
});

describe("signals", () => {
  test("SIGINT while waiting for idle: nothing changes", async () => {
    const world = new World();
    world.inFlight = [BUSY];
    world.onPoll = (poll): void => {
      if (poll === 3) world.signal("SIGINT");
    };

    expect(await run(world, ["--apply"])).toBe(1);

    expect(world.mutations()).toEqual([]);
    expect(world.err.join("\n")).toContain("interrupted by SIGINT");
    expect(world.signalHandler).toBeNull();
  });

  test("SIGTERM during the install: stop after it and roll back", async () => {
    const world = new World();
    world.depsChanged = true;
    world.duringInstall = (): void => {
      world.duringInstall = (): void => undefined;
      world.signal("SIGTERM");
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

  test("a second signal starts the worker, writes a closing line and exits 130", async () => {
    const world = new World();
    world.depsChanged = true;
    world.duringInstall = (): void => {
      world.duringInstall = (): void => undefined;
      world.signal("SIGINT");
      world.signal("SIGINT");
    };

    await run(world, ["--apply"]);

    expect(world.exitCode).toBe(130);
    expect(world.events).toContain("unfreeze");
    expect(world.files.get(HISTORY)).toContain("interrupted head=");
  });
});

describe("history and exit codes", () => {
  test("a failed closing history write does not turn a successful update into a failure", async () => {
    const world = new World();
    const deps = world.deps();
    const fs = deps.fs;
    deps.fs = {
      ...fs,
      appendText: (path, text): Promise<void> =>
        text.includes(" ok ") ? Promise.reject(new Error("EROFS")) : fs.appendText(path, text),
    };

    expect(await runUpdateCommand(["--apply"], STORAGE, deps)).toBe(0);

    expect(world.head).toBe(SHA_B);
    expect(world.out.join("\n")).toContain(`WARNING could not append "ok ${SHA_B}"`);
  });

  test("the install and the hint use the services' bun", async () => {
    const world = new World();
    world.serviceBun = "/home/op/.bun/bin/bun";
    world.cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-worker.service\n";

    expect(await run(world, ["--json"])).toBe(0);

    const report = world.json();
    expect(report.bun).toBe("/home/op/.bun/bin/bun");
    expect(JSON.stringify(report.selfSafety)).toContain(
      "-- /home/op/.bun/bin/bun /srv/penumbra/packages/cli/bin/penumbra.ts update --apply",
    );
  });
});
