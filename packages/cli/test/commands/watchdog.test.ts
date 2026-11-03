import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LaunchctlResult,
  RunWatchdogOptions,
  WatchdogDependencies,
  WatchdogResult,
} from "@src/commands/watchdog.js";

async function runWatchdog(options: RunWatchdogOptions): Promise<WatchdogResult | null> {
  const module = await import("@src/commands/watchdog.js").catch(() => null);
  return module?.runWatchdog ? await module.runWatchdog(options) : null;
}

const roots: string[] = [];

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "penumbra-watchdog-"));
  roots.push(root);
  return root;
}

function dependencies(overrides: Partial<WatchdogDependencies> = {}): WatchdogDependencies {
  return {
    now: () => new Date("2026-08-18T10:00:00.000Z"),
    probeDaemon: (): Promise<boolean> => Promise.resolve(false),
    launchctl: (): Promise<LaunchctlResult> =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    uid: () => 501,
    plistPath: "/tmp/dev.penumbra.daemon.plist",
    error: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("watchdog reports a healthy daemon without launchctl or corrective action", async () => {
  const launchctlCalls: string[][] = [];

  const result = await runWatchdog({
    storageRoot: setupRoot(),
    dependencies: dependencies({
      probeDaemon: (): Promise<boolean> => Promise.resolve(true),
      launchctl: (args): Promise<LaunchctlResult> => {
        launchctlCalls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    }),
  });

  expect(result).toMatchObject({
    status: "healthy",
    action: "none",
    downSince: null,
    downtimeMs: 0,
  });
  expect(launchctlCalls).toEqual([]);
});

test("watchdog bootstraps an absent service only when healing is enabled", async () => {
  const launchctlCalls: string[][] = [];

  const result = await runWatchdog({
    storageRoot: setupRoot(),
    heal: true,
    dependencies: dependencies({
      launchctl: (args): Promise<LaunchctlResult> => {
        launchctlCalls.push(args);
        return Promise.resolve({
          exitCode: args[0] === "print" ? 1 : 0,
          stdout: "",
          stderr: "Could not find service",
        });
      },
    }),
  });

  expect(result).toMatchObject({ status: "service_absent", action: "bootstrap" });
  expect(launchctlCalls).toEqual([
    ["print", "gui/501/dev.penumbra.daemon"],
    ["bootstrap", "gui/501", "/tmp/dev.penumbra.daemon.plist"],
  ]);
});

test("watchdog kickstarts a present but unhealthy service when healing is enabled", async () => {
  const launchctlCalls: string[][] = [];

  const result = await runWatchdog({
    storageRoot: setupRoot(),
    heal: true,
    dependencies: dependencies({
      launchctl: (args): Promise<LaunchctlResult> => {
        launchctlCalls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    }),
  });

  expect(result).toMatchObject({ status: "service_present_unhealthy", action: "kickstart" });
  expect(launchctlCalls).toEqual([
    ["print", "gui/501/dev.penumbra.daemon"],
    ["kickstart", "-k", "gui/501/dev.penumbra.daemon"],
  ]);
});

test("watchdog observe-only mode never makes a corrective launchctl call", async () => {
  const launchctlCalls: string[][] = [];

  const result = await runWatchdog({
    storageRoot: setupRoot(),
    dependencies: dependencies({
      launchctl: (args): Promise<LaunchctlResult> => {
        launchctlCalls.push(args);
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Could not find service" });
      },
    }),
  });

  expect(result).toMatchObject({ status: "service_absent", action: "none" });
  expect(launchctlCalls).toEqual([["print", "gui/501/dev.penumbra.daemon"]]);
});

test("watchdog does not bootstrap for an unclassified launchctl query failure", async () => {
  const launchctlCalls: string[][] = [];

  const result = await runWatchdog({
    storageRoot: setupRoot(),
    heal: true,
    dependencies: dependencies({
      launchctl: (args): Promise<LaunchctlResult> => {
        launchctlCalls.push(args);
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Operation not permitted" });
      },
    }),
  });

  expect(result).toMatchObject({ status: "launchctl_unknown", action: "none" });
  expect(launchctlCalls).toEqual([["print", "gui/501/dev.penumbra.daemon"]]);
});

test("watchdog records a down observation when the selected remediation fails", async () => {
  const root = setupRoot();
  let result: WatchdogResult | null = null;
  try {
    result = await runWatchdog({
      storageRoot: root,
      heal: true,
      dependencies: dependencies({
        launchctl: (args): Promise<LaunchctlResult> => {
          if (args[0] === "print") {
            return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Could not find service" });
          }
          throw new Error("bootstrap failed");
        },
      }),
    });
  } catch {
    result = null;
  }

  expect(result).toMatchObject({
    status: "service_absent",
    action: "bootstrap",
    actionExitCode: null,
  });
  expect(readFileSync(join(root, "watchdog.jsonl"), "utf8")).toContain("service_absent");
});

test("watchdog preserves the first down observation and accumulates downtime", async () => {
  const root = setupRoot();
  const first = await runWatchdog({
    storageRoot: root,
    dependencies: dependencies({
      now: () => new Date("2026-08-18T10:00:00.000Z"),
      launchctl: (): Promise<LaunchctlResult> =>
        Promise.resolve({ exitCode: 1, stdout: "", stderr: "not found" }),
    }),
  });
  const second = await runWatchdog({
    storageRoot: root,
    dependencies: dependencies({
      now: () => new Date("2026-08-18T10:05:00.000Z"),
      launchctl: (): Promise<LaunchctlResult> =>
        Promise.resolve({ exitCode: 1, stdout: "", stderr: "not found" }),
    }),
  });

  expect(first).toMatchObject({ downSince: "2026-08-18T10:00:00.000Z", downtimeMs: 0 });
  expect(second).toMatchObject({ downSince: "2026-08-18T10:00:00.000Z", downtimeMs: 300_000 });
  const records = readFileSync(join(root, "watchdog.jsonl"), "utf8").trim().split("\n");
  expect(records).toHaveLength(2);
});
