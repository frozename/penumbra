import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closeSink,
  getSink,
  initSink,
  resolveDefaultInvocationLogPath,
} from "../src/invocation-sink-registry.js";

const repoRoot = resolve(import.meta.dir, "../../..");

let tempDirs: string[] = [];

function makeTempDir(prefix = "sink-reg-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await closeSink();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("invocation sink registry — lifecycle", () => {
  it("initSink + repeated getSink return the same singleton instance", async () => {
    const path = join(makeTempDir(), "mcp-invocations.jsonl");
    const fromInit = await initSink(path);
    expect(getSink()).toBe(fromInit);
    expect(getSink()).toBe(fromInit);
  });

  it("initSink throws when already initialized (no silent reconfiguration)", async () => {
    const path = join(makeTempDir(), "mcp-invocations.jsonl");
    await initSink(path);
    let thrown: unknown = null;
    try {
      await initSink(join(makeTempDir(), "other.jsonl"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/already initialized/);
  });

  it("getSink throws before initSink (no silent no-op writes)", () => {
    expect(() => getSink()).toThrow(/not initialized/);
  });

  it("closeSink then initSink reopens with a fresh sink instance", async () => {
    const path = join(makeTempDir(), "mcp-invocations.jsonl");
    const first = await initSink(path);
    await closeSink();
    const second = await initSink(path);
    expect(second).not.toBe(first);
  });

  it("closeSink is idempotent and a no-op when nothing is open", async () => {
    let firstError: unknown = null;
    let secondError: unknown = null;
    try {
      await closeSink();
    } catch (err) {
      firstError = err;
    }
    try {
      await closeSink();
    } catch (err) {
      secondError = err;
    }
    expect(firstError).toBeNull();
    expect(secondError).toBeNull();
  });

  it("concurrent close requests share one promise (no torn-open second writer)", async () => {
    const path = join(makeTempDir(), "mcp-invocations.jsonl");
    await initSink(path);

    const a = closeSink();
    const b = closeSink();
    expect(a).toBe(b);
    await Promise.all([a, b]);
  });

  it("initSink awaits an in-progress close before opening a new sink", async () => {
    const path = join(makeTempDir(), "mcp-invocations.jsonl");
    await initSink(path);

    const closeP = closeSink();
    // Kick off init while close is still in flight; it must wait, not race.
    const initP = initSink(join(makeTempDir(), "second.jsonl"));
    await closeP;
    const sink = await initP;
    expect(sink).toBeDefined();
  });

  it("getSink throws while a close is in progress", async () => {
    const path = join(makeTempDir(), "mcp-invocations.jsonl");
    await initSink(path);
    const closeP = closeSink();
    expect(() => getSink()).toThrow(/closing/);
    await closeP;
  });
});

describe("invocation sink registry — XDG path resolution", () => {
  it("resolveDefaultInvocationLogPath uses $XDG_STATE_HOME/penumbra when set", () => {
    const xdg = makeTempDir();
    const p = resolveDefaultInvocationLogPath({ XDG_STATE_HOME: xdg }, "/should-not-be-used");
    expect(p).toBe(resolve(xdg, "penumbra", "mcp-invocations.jsonl"));
  });

  it("resolveDefaultInvocationLogPath falls back to <home>/.local/state when XDG_STATE_HOME is unset", () => {
    const home = makeTempDir();
    const p = resolveDefaultInvocationLogPath({}, home);
    expect(p).toBe(resolve(home, ".local", "state", "penumbra", "mcp-invocations.jsonl"));
  });

  it("resolveDefaultInvocationLogPath falls back when XDG_STATE_HOME is empty (XDG spec)", () => {
    const home = makeTempDir();
    const p = resolveDefaultInvocationLogPath({ XDG_STATE_HOME: "" }, home);
    expect(p).toBe(resolve(home, ".local", "state", "penumbra", "mcp-invocations.jsonl"));
  });

  it("resolveDefaultInvocationLogPath canonicalizes a relative XDG_STATE_HOME to an absolute path", () => {
    const p = resolveDefaultInvocationLogPath({ XDG_STATE_HOME: "../relative-state" }, "/unused");
    expect(p.startsWith("/")).toBe(true);
  });

  it("initSink with resolved default path creates the file under XDG_STATE_HOME", async () => {
    const xdg = makeTempDir();
    const path = resolveDefaultInvocationLogPath({ XDG_STATE_HOME: xdg }, "/unused");
    await initSink(path);
    await closeSink();
    expect(existsSync(path)).toBe(true);
  });

  it("XDG resolution lives only in invocation-sink-registry.ts (grep guard)", () => {
    const check = spawnSync(
      "sh",
      [
        "-lc",
        'grep -rn "XDG_STATE_HOME\\|homedir()" packages/mcp/src --include="*.ts" | grep -v invocation-sink-registry',
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const combined = `${check.stdout}${check.stderr}`.trim();
    expect(combined).toBe("");
  });
});
