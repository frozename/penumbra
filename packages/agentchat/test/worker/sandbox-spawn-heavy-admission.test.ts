import type { HeavyJobGate, HeavyJobGateEntry } from "@penumbra/core";

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as sb from "@src/worker/sandbox-spawn.js";

const cwd = mkdtempSync(join(tmpdir(), "sandbox-heavy-admission-"));

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// classifyHeavyCommand does not exist at this base — read it off the module
// namespace so the RED failure is the typeof assertion below, not a
// missing-export link error.
const classify = (sb as Record<string, unknown>).classifyHeavyCommand as
  | ((argv: readonly string[]) => string | null)
  | undefined;

interface GateCalls {
  enterLabels: string[];
  order: string[];
  releases: number;
}

function gateCalls(): GateCalls {
  return { enterLabels: [], order: [], releases: 0 };
}

function spawnOpts(opts: {
  argv: string[];
  signal?: AbortSignal;
  heavyJobGate?: HeavyJobGate;
}): sb.SpawnSandboxedOpts & { heavyJobGate?: unknown } {
  return { cwd, timeoutMs: 10_000, outputMaxBytes: 1_048_576, ...opts };
}

describe("classifyHeavyCommand", () => {
  test.each([
    [["eslint", "."], "lint"],
    [["npx", "eslint", "src"], "lint"],
    [["bun", "x", "tsc", "--noEmit", "-p", "packages/core"], "typecheck"],
    [["tsc", "-b"], "typecheck"],
    [["bun", "test", "packages/core"], "test"],
    [["bun", "run", "lint:strict"], "lint"],
    [["npm", "run", "typecheck"], "typecheck"],
    [["pnpm", "test"], "test"],
    [["bun", "run", "build"], "build"],
    [["bash", "-c", "cd pkg && bun test"], "test"],
    [["bash", "-lc", "FOO=1 timeout 600 eslint --max-warnings=0 ."], "lint"],
    [["sh", "-c", "git status; tsc --noEmit"], "typecheck"],
  ])("argv %j -> %s", (argv, expected) => {
    expect(typeof classify).toBe("function");
    if (typeof classify !== "function") return;
    expect(classify(argv)).toBe(expected);
  });

  test.each([
    [["git", "status"]],
    [["ls", "-la"]],
    [["bun", "--version"]],
    [["tsc", "--version"]],
    [["eslint", "--help"]],
    [["bun", "run", "dev"]],
    [["bash", "-c", "echo test && cat lint.txt"]],
    [["rg", "eslint"]],
    [[]],
  ])("argv %j -> null", (argv) => {
    expect(typeof classify).toBe("function");
    if (typeof classify !== "function") return;
    expect(classify(argv)).toBeNull();
  });
});

describe("spawnSandboxed heavy-job admission", () => {
  test("a denied gate runs nothing and reports a resource kill", async () => {
    const calls = gateCalls();
    const gate: HeavyJobGate = {
      enter: (label: string): ReturnType<HeavyJobGate["enter"]> => {
        calls.enterLabels.push(label);
        calls.order.push(`enter:${label}`);
        return Promise.resolve({
          ok: false,
          reason: "host memory admission timeout: MemAvailable 4.0 GiB < 20 GiB after 900s",
        });
      },
    };
    const marker = join(cwd, "ran");
    const result = await sb.spawnSandboxed(
      spawnOpts({ argv: ["bash", "-c", `touch "${marker}"; eslint .`], heavyJobGate: gate }),
    );

    expect(calls.enterLabels).toEqual(["terminal-lint"]);
    expect(existsSync(marker)).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.killReason).toBe("resource");
    expect(result.output).toContain("host memory admission timeout");
    expect(calls.releases).toBe(0);
  });

  test("an admitted gate is held across the run and released exactly once", async () => {
    const calls = gateCalls();
    const gate: HeavyJobGate = {
      enter: (label: string): ReturnType<HeavyJobGate["enter"]> => {
        calls.enterLabels.push(label);
        calls.order.push(`enter:${label}`);
        return Promise.resolve({
          ok: true,
          admission: { admitted: true, availableGiB: 30, waitedMs: 0 },
          release: (): Promise<void> => {
            calls.releases++;
            calls.order.push("release");
            return Promise.resolve();
          },
        });
      },
    };
    const done = sb.spawnSandboxed(
      spawnOpts({
        argv: ["bash", "-c", "echo hi; tsc -p nope >/dev/null 2>&1; exit 0"],
        heavyJobGate: gate,
      }),
    );
    const result = await done;

    // release pushes into order inside the spawn's cleanup, so done resolving
    // means it ran after the process exited.
    expect(calls.order).toEqual(["enter:terminal-typecheck", "release"]);
    expect(calls.releases).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hi");
  });

  test("aborting while the gate waits reports cancelled, not resource", async () => {
    const calls = gateCalls();
    let receivedSignal: AbortSignal | undefined;
    const gate: HeavyJobGate = {
      enter: (label: string, signal?: AbortSignal): Promise<HeavyJobGateEntry> => {
        calls.enterLabels.push(label);
        calls.order.push(`enter:${label}`);
        receivedSignal = signal;
        return new Promise<HeavyJobGateEntry>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve({ ok: false, reason: "heavy-job lock /x not acquired within 0s" });
            },
            { once: true },
          );
        });
      },
    };
    const controller = new AbortController();
    const marker = join(cwd, "ran2");
    const done = sb.spawnSandboxed(
      spawnOpts({
        argv: ["bash", "-c", `touch "${marker}"; bun test`],
        signal: controller.signal,
        heavyJobGate: gate,
      }),
    );
    const abortTimer = setTimeout(() => {
      controller.abort();
    }, 20);
    const result = await done;
    clearTimeout(abortTimer);

    expect(calls.enterLabels).toEqual(["terminal-test"]);
    expect(receivedSignal).toBe(controller.signal);
    expect(result.killReason).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
  });

  test("a gate is never consulted for argv that is not heavy", async () => {
    const calls = gateCalls();
    const gate: HeavyJobGate = {
      enter: (label: string): ReturnType<HeavyJobGate["enter"]> => {
        calls.enterLabels.push(label);
        return Promise.resolve({ ok: false, reason: "unreachable" });
      },
    };
    const result = await sb.spawnSandboxed(
      spawnOpts({ argv: ["bash", "-c", "echo ok"], heavyJobGate: gate }),
    );

    expect(calls.enterLabels).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ok");
  });

  test("without a gate a heavy argv runs ungated", async () => {
    const result = await sb.spawnSandboxed(
      spawnOpts({ argv: ["bash", "-c", "eslint --version >/dev/null 2>&1; echo fine"] }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("fine");
  });
});
