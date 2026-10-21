import { describe, expect, test } from "bun:test";

import { createDaemonPort, createLogReader } from "@src/commands/update/daemon.js";
import { createCiPort, createGitPort, parseGhRunState } from "@src/commands/update/git.js";
import {
  resolveBunPath,
  resolveHeavyLock,
  scopeInstallArgv,
} from "@src/commands/update/install.js";
import {
  createLaunchdManager,
  createSystemdManager,
  parseExecStartArgv,
  parseLaunchdPrint,
  parseSystemdEnvironment,
  parseSystemdLogTarget,
  selectServiceManager,
} from "@src/commands/update/service-manager.js";
import type { Exec, ExecResult, FsPort, Http } from "@src/commands/update/types.js";

const NAMES = {
  daemonUnit: "penumbra-daemon.service",
  workerUnit: "penumbra-worker.service",
  daemonLabel: "dev.penumbra.daemon",
  workerLabel: "dev.penumbra.worker",
};

function fakeExec(respond: (argv: string[]) => Partial<ExecResult> = () => ({})): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = (argv) => {
    calls.push([...argv]);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...respond([...argv]) });
  };
  return { exec, calls };
}

const SHOW_LOADED = [
  "MainPID=2077114",
  "ExecStart={ path=/home/op/.bun/bin/bun ; argv[]=/home/op/.bun/bin/bun /srv/penumbra/packages/cli/bin/penumbra.ts start ; ignore_errors=no ; pid=2077114 ; code=(null) ; status=0/0 }",
  'Environment=PENUMBRA_JOB_HEAVY_LOCK=/locks/heavy.lock "NOTE=two words"',
  "WorkingDirectory=/srv/penumbra",
  "LoadState=loaded",
  "ActiveState=active",
].join("\n");

describe("systemd --user manager", () => {
  test("parses show output into unit state", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: SHOW_LOADED }));
    const state = await createSystemdManager(exec, NAMES, "/home/op").state();
    expect(state.daemon).toEqual({
      name: "penumbra-daemon.service",
      loaded: true,
      active: true,
      pid: 2077114,
      workingDirectory: "/srv/penumbra",
      argv: ["/home/op/.bun/bin/bun", "/srv/penumbra/packages/cli/bin/penumbra.ts", "start"],
      environment: { PENUMBRA_JOB_HEAVY_LOCK: "/locks/heavy.lock", NOTE: "two words" },
    });
    expect(calls[0]).toEqual([
      "systemctl",
      "--user",
      "show",
      "penumbra-daemon.service",
      "-p",
      "LoadState,ActiveState,MainPID,WorkingDirectory,ExecStart,Environment",
    ]);
  });

  test("freeze stops the worker; restart restarts the daemon and then starts the worker", async () => {
    const { exec, calls } = fakeExec();
    const manager = createSystemdManager(exec, NAMES, "/home/op");
    await manager.freeze();
    await manager.restart();
    await manager.unfreeze();
    expect(calls.map((c) => c.slice(2).join(" "))).toEqual([
      "stop penumbra-worker.service",
      "restart penumbra-daemon.service",
      "start penumbra-worker.service",
      "start penumbra-worker.service",
    ]);
  });

  test("a failing systemctl call throws with its stderr", async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: "Failed to connect to bus\n" }));
    let message = "";
    await createSystemdManager(exec, NAMES, "/home/op")
      .restart()
      .catch((err: unknown) => {
        message = String(err);
      });
    expect(message).toContain(
      "systemctl --user restart penumbra-daemon.service failed (exit 1): Failed to connect to bus",
    );
  });

  test("lists live job scopes but not penumbra-update's own", async () => {
    const { exec } = fakeExec(() => ({
      stdout:
        "penumbra-acp-claude-1a.scope loaded active running penumbra job (acp-claude)\n" +
        "penumbra-update-install-9f.scope loaded active running penumbra job (update-install)\n",
    }));
    expect(await createSystemdManager(exec, NAMES, "/home/op").jobScopes()).toEqual([
      "penumbra-acp-claude-1a.scope",
    ]);
  });

  test("reads BindsTo, null when unreadable", async () => {
    const ok = fakeExec(() => ({ stdout: "penumbra-worker.service\n" }));
    expect(await createSystemdManager(ok.exec, NAMES, "/h").bindsTo("penumbra-x.scope")).toEqual([
      "penumbra-worker.service",
    ]);
    const bad = fakeExec(() => ({ code: 1 }));
    expect(
      await createSystemdManager(bad.exec, NAMES, "/h").bindsTo("penumbra-x.scope"),
    ).toBeNull();
  });

  test("log target follows the last StandardOutput= across drop-ins", () => {
    const unit =
      "[Service]\nStandardOutput=journal\n# drop-in\n[Service]\nStandardOutput=append:%h/.penumbra/logs/daemon.log\n";
    expect(parseSystemdLogTarget(unit, "d.service", "/home/op")).toEqual({
      kind: "file",
      path: "/home/op/.penumbra/logs/daemon.log",
    });
    expect(parseSystemdLogTarget("[Service]\nExecStart=x\n", "d.service", "/h")).toEqual({
      kind: "journal",
      unit: "d.service",
    });
    expect(parseSystemdLogTarget("StandardOutput=file:%t/x.log\n", "d.service", "/h").kind).toBe(
      "none",
    );
  });

  test("selection refuses when the units are not loaded (never guesses)", async () => {
    const { exec } = fakeExec(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nMainPID=0\n",
    }));
    const sel = await selectServiceManager({
      choice: "auto",
      platform: "linux",
      exec,
      uid: 1000,
      home: "/h",
      names: NAMES,
    });
    expect(sel.manager).toBeNull();
    expect(sel.reason).toBe(
      "systemd --user has no penumbra-daemon.service or penumbra-worker.service loaded",
    );
    const none = await selectServiceManager({
      choice: "auto",
      platform: "win32",
      exec,
      uid: 0,
      home: "/h",
      names: NAMES,
    });
    expect(none.reason).toBe("no supported service manager on platform=win32");
  });

  test("small parsers", () => {
    expect(parseExecStartArgv("{ path=/x ; argv[]=/x a b ; pid=1 }")).toEqual(["/x", "a", "b"]);
    expect(parseSystemdEnvironment("")).toEqual({});
  });
});

const LAUNCHD_PRINT = `gui/501/dev.penumbra.daemon = {
	active count = 1
	path = /Users/op/Library/LaunchAgents/dev.penumbra.daemon.plist
	state = running

	program = /Users/op/.bun/bin/bun
	arguments = {
		/Users/op/.bun/bin/bun
		/Users/op/penumbra/packages/cli/bin/penumbra.ts
		start
	}

	working directory = /Users/op/penumbra

	stdout path = /Users/op/.penumbra/logs/daemon.log
	environment = {
		PENUMBRA_JOB_HEAVY_LOCK => /Users/op/.heavy.lock
	}
	pid = 4321
}`;

describe("launchd manager", () => {
  test("parses launchctl print", () => {
    const parsed = parseLaunchdPrint("dev.penumbra.daemon", LAUNCHD_PRINT, true);
    expect(parsed).toMatchObject({
      active: true,
      pid: 4321,
      workingDirectory: "/Users/op/penumbra",
      argv: ["/Users/op/.bun/bin/bun", "/Users/op/penumbra/packages/cli/bin/penumbra.ts", "start"],
      environment: { PENUMBRA_JOB_HEAVY_LOCK: "/Users/op/.heavy.lock" },
      stdoutPath: "/Users/op/.penumbra/logs/daemon.log",
    });
  });

  test("restart kickstarts the daemon then the worker; there is no freeze", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: LAUNCHD_PRINT }));
    const manager = createLaunchdManager(exec, NAMES, 501);
    expect(manager.canFreeze).toBe(false);
    await manager.freeze();
    await manager.restart();
    expect(calls).toEqual([
      ["launchctl", "kickstart", "-k", "gui/501/dev.penumbra.daemon"],
      ["launchctl", "kickstart", "-k", "gui/501/dev.penumbra.worker"],
    ]);
    expect(await manager.logSource("daemon")).toEqual({
      kind: "file",
      path: "/Users/op/.penumbra/logs/daemon.log",
    });
  });

  test("an unknown label is not loaded", async () => {
    const { exec } = fakeExec(() => ({ code: 113, stderr: "Could not find service" }));
    const sel = await selectServiceManager({
      choice: "launchd",
      platform: "darwin",
      exec,
      uid: 501,
      home: "/h",
      names: NAMES,
    });
    expect(sel.reason).toBe(
      "launchd (gui domain) has no dev.penumbra.daemon or dev.penumbra.worker loaded",
    );
  });
});

describe("git and CI ports", () => {
  test("fetches the remote branch of an origin/* ref, fast-forward only", async () => {
    const { exec, calls } = fakeExec();
    const git = createGitPort(exec, "/srv/penumbra");
    await git.fetch("origin/main");
    await git.fetch("v1.2.3");
    await git.fastForward("b".repeat(40));
    await git.resetHard("a".repeat(40));
    expect(calls[0]?.slice(0, 6)).toEqual([
      "git",
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      "/srv/penumbra",
    ]);
    expect(calls.map((c) => c.slice(6).join(" "))).toEqual([
      "fetch --quiet origin main",
      "fetch --quiet origin",
      `merge --ff-only --quiet ${"b".repeat(40)}`,
      `reset --quiet --hard ${"a".repeat(40)}`,
    ]);
  });

  test("dependency changes come from git diff --quiet over the lock and manifests", async () => {
    const changed = fakeExec(() => ({ code: 1 }));
    expect(await createGitPort(changed.exec, "/r").depsChanged("a", "b")).toBe(true);
    expect(changed.calls[0]).toEqual([
      "git",
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      "/r",
      "diff",
      "--quiet",
      "a",
      "b",
      "--",
      "bun.lock",
      "package.json",
      "packages/*/package.json",
      "packages/integrations/*/package.json",
    ]);
    expect(await createGitPort(fakeExec().exec, "/r").depsChanged("a", "b")).toBe(false);
  });

  test("status for --check never takes optional locks", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: " M a.ts\n" }));
    expect(await createGitPort(exec, "/r").trackedChanges()).toEqual([" M a.ts"]);
    expect(calls[0]).toEqual([
      "git",
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      "/r",
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
  });

  test("a detached HEAD has no branch", async () => {
    const { exec } = fakeExec(() => ({ code: 1 }));
    expect(await createGitPort(exec, "/r").branch()).toBeNull();
  });

  test("CI state maps gh run list output", async () => {
    expect(parseGhRunState('[{"status":"completed","conclusion":"success"}]')).toBe("success");
    expect(parseGhRunState('[{"status":"in_progress","conclusion":""}]')).toBe("pending");
    expect(parseGhRunState("[]")).toBe("none");
    expect(parseGhRunState("nope")).toBe("unknown");
    const missingGh = fakeExec(() => ({ code: 127, stderr: "ENOENT" }));
    expect(await createCiPort(missingGh.exec, "/r").state("abc")).toBe("unknown");
    const gh = fakeExec(() => ({ stdout: '[{"status":"completed","conclusion":"failure"}]' }));
    expect(await createCiPort(gh.exec, "/r").state("abc")).toBe("failure");
    expect(gh.calls[0]).toEqual([
      "gh",
      "run",
      "list",
      "--commit",
      "abc",
      "--workflow",
      "check",
      "--limit",
      "1",
      "--json",
      "status,conclusion",
    ]);
  });
});

function memFs(files: Record<string, string>): FsPort {
  return {
    readText: (path) => Promise.resolve(files[path] ?? null),
    appendText: () => Promise.resolve(),
    size: (path) => Promise.resolve(files[path]?.length ?? null),
    readFrom: (path, offset) => Promise.resolve((files[path] ?? "").slice(offset)),
    realpath: (path) => Promise.resolve(path),
  };
}

describe("daemon port and log reader", () => {
  test("health reads the port file and requires status ok", async () => {
    const urls: string[] = [];
    const http: Http = (url) => {
      urls.push(url);
      return Promise.resolve({ status: 200, text: '{"status":"ok","version":"0.0.0"}' });
    };
    const daemon = createDaemonPort("/state", memFs({ "/state/port": "45787\n" }), http);
    expect(await daemon.health()).toEqual({ ok: true, port: 45787, detail: "ok" });
    expect(urls).toEqual(["http://127.0.0.1:45787/health"]);
    const noPort = createDaemonPort("/state", memFs({}), http);
    expect((await noPort.health()).ok).toBe(false);
  });

  test("in-flight splits dispatched from approved handoffs, with the bearer token", async () => {
    let auth = "";
    const http: Http = (url, init) => {
      auth = init?.headers?.authorization ?? "";
      expect(url).toBe("http://127.0.0.1:1234/handoffs?status=dispatched,approved");
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({
          handoffs: [
            { handoff_id: "h1", to_agent: "codex", worker_id: "w1", status: "dispatched" },
            { handoff_id: "h2", to_agent: "claude", worker_id: null, status: "approved" },
          ],
        }),
      });
    };
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234", "/s/token": "tok\n" }), http);
    expect(await daemon.inFlight()).toEqual({
      ok: true,
      dispatched: [{ handoffId: "h1", agent: "codex", workerId: "w1" }],
      approved: 1,
    });
    expect(auth).toBe("Bearer tok");
  });

  test("in-flight reports HTTP and transport errors", async () => {
    const fs = memFs({ "/s/port": "1234", "/s/token": "tok" });
    const denied = createDaemonPort("/s", fs, () => Promise.resolve({ status: 401, text: "" }));
    expect(await denied.inFlight()).toEqual({
      ok: false,
      error: "GET /handoffs returned HTTP 401",
    });
    const down = createDaemonPort("/s", fs, () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await down.inFlight()).toEqual({
      ok: false,
      error: "GET /handoffs failed: ECONNREFUSED",
    });
  });

  test("file logs read from the byte offset; journal logs from a timestamp", async () => {
    const files: Record<string, string> = { "/log": "old\n" };
    const { exec, calls } = fakeExec(() => ({ stdout: "journal line\n" }));
    const reader = createLogReader(memFs(files), exec, {
      now: () => 1_700_000_000_123,
      sleep: () => Promise.resolve(),
    });
    const cursor = await reader.cursor({ kind: "file", path: "/log" });
    files["/log"] = "old\nnew\n";
    expect(await reader.readSince({ kind: "file", path: "/log" }, cursor)).toBe("new\n");
    const journal = { kind: "journal" as const, unit: "penumbra-daemon.service" };
    expect(await reader.readSince(journal, await reader.cursor(journal))).toBe("journal line\n");
    expect(calls[0]).toEqual([
      "journalctl",
      "--user",
      "--unit",
      "penumbra-daemon.service",
      "--since",
      "@1700000000",
      "--output",
      "cat",
      "--no-pager",
    ]);
  });
});

describe("install helpers", () => {
  test("heavy-job lock: shell env, then the worker unit's env, then the default", () => {
    const state = (lock?: string): Parameters<typeof resolveHeavyLock>[1] => {
      const unit = {
        name: "u",
        loaded: true,
        active: true,
        pid: 1,
        workingDirectory: null,
        argv: [],
        environment: {},
      };
      return {
        daemon: unit,
        worker: { ...unit, environment: lock ? { PENUMBRA_JOB_HEAVY_LOCK: lock } : {} },
      };
    };
    expect(
      resolveHeavyLock({ PENUMBRA_JOB_HEAVY_LOCK: "/env.lock" }, state("/unit.lock"), "/h"),
    ).toEqual({
      path: "/env.lock",
      source: "env",
    });
    expect(resolveHeavyLock({}, state("/unit.lock"), "/h")).toEqual({
      path: "/unit.lock",
      source: "worker-unit",
    });
    expect(resolveHeavyLock({}, null, "/h")).toEqual({
      path: "/h/.penumbra/locks/heavy-job.lock",
      source: "default",
    });
  });

  test("the install uses the services' bun, else the CLI's", () => {
    const unit = {
      name: "u",
      loaded: true,
      active: true,
      pid: 1,
      workingDirectory: null,
      environment: {},
    };
    const withArgv = (argv: string[]): Parameters<typeof resolveBunPath>[0] => ({
      daemon: { ...unit, argv },
      worker: { ...unit, argv: [] },
    });
    expect(
      resolveBunPath(withArgv(["/home/op/.bun/bin/bun", "/x/penumbra.ts"]), "/usr/bin/bun"),
    ).toBe("/home/op/.bun/bin/bun");
    expect(resolveBunPath(withArgv(["/usr/bin/node", "/x.js"]), "/usr/bin/bun")).toBe(
      "/usr/bin/bun",
    );
    expect(resolveBunPath(withArgv(["bun", "/x.ts"]), "/usr/bin/bun")).toBe("/usr/bin/bun");
    expect(resolveBunPath(null, "/usr/bin/bun")).toBe("/usr/bin/bun");
  });

  test("the install runs unscoped when PENUMBRA_JOB_SCOPE=off", () => {
    expect(
      scopeInstallArgv(["/bun", "install", "--frozen-lockfile"], { PENUMBRA_JOB_SCOPE: "off" }),
    ).toEqual(["/bun", "install", "--frozen-lockfile"]);
  });
});
