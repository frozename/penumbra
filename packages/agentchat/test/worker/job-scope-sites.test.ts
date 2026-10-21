// Each dispatched-job spawn site routes through wrapResourceScopeArgv. A fake
// systemd-run (records its argv, then execs everything after `--`) stands in
// for the real one so this runs on any host.
import { primeResourceScope, resetResourceScopeForTest, runIsolatedInstall } from "@penumbra/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAcpServer } from "@src/adapters/acp-server.js";
import { spawnCliAdapter } from "@src/adapters/cli-spawn.js";
import { startStdioAcpServer } from "@src/adapters/stdio-acp-server.js";
import { spawnSandboxed } from "@src/worker/sandbox-spawn.js";

const root = mkdtempSync(join(tmpdir(), "penumbra-job-scope-sites-"));
const binDir = join(root, "bin");
const fakeSystemdRun = join(binDir, "systemd-run");
const argvLog = join(root, "systemd-run.argv");
const runtimeDir = join(root, "runtime");
const previousScope = process.env.PENUMBRA_JOB_SCOPE;

function loggedRuns(): string[] {
  return existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : [];
}

beforeAll(async () => {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(runtimeDir, "systemd"), { recursive: true });
  writeFileSync(
    fakeSystemdRun,
    `#!/bin/sh\necho "$*" >> '${argvLog}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
  );
  chmodSync(fakeSystemdRun, 0o755);
  process.env.PENUMBRA_JOB_SCOPE = "on";
  const res = await primeResourceScope({
    deps: {
      platform: "linux",
      env: { PATH: binDir, XDG_RUNTIME_DIR: runtimeDir },
      exists: (p) => p === join(runtimeDir, "systemd", "private") || existsSync(p),
      readFile: () => "",
    },
    spawn: () => Promise.resolve({ exitCode: 0, signal: null, stderr: "" }),
  });
  expect(res.available).toBe(true);
});

afterAll(() => {
  if (previousScope === undefined) delete process.env.PENUMBRA_JOB_SCOPE;
  else process.env.PENUMBRA_JOB_SCOPE = previousScope;
  resetResourceScopeForTest();
  rmSync(root, { recursive: true, force: true });
});

describe("job scope spawn sites", () => {
  test("A1 ACP terminal: per-command scope; XDG_RUNTIME_DIR reaches systemd-run, not the job", async () => {
    const r = await spawnSandboxed({
      argv: ["sh", "-c", 'echo "xdg=${XDG_RUNTIME_DIR:-unset}"'],
      cwd: root,
      timeoutMs: 10_000,
      outputMaxBytes: 4096,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("xdg=unset");
    expect(r.argv).toContain(fakeSystemdRun);
    expect(r.argv[1]).toBe(`XDG_RUNTIME_DIR=${runtimeDir}`);
    expect(loggedRuns().at(-1)).toContain("--unit=penumbra-terminal-");
    expect(r.envKeys).not.toContain("XDG_RUNTIME_DIR");
  });

  test("A2 agent CLI: the CLI process (and its tool children) runs in one scope", async () => {
    const res = await spawnCliAdapter({
      command: "sh",
      args: ["-c", "cat >/dev/null; echo from-cli"],
      prompt: "hello",
      signal: new AbortController().signal,
    });
    expect(res.text.trim()).toBe("from-cli");
    expect(loggedRuns().at(-1)).toContain("--unit=penumbra-agent-cli-");
  });

  test("A3 stdio ACP server: the server process runs in its own scope", async () => {
    const handle = await startStdioAcpServer({ binary: "sh", args: ["-c", "exit 0"] });
    expect(await handle.exited).toBe(0);
    expect(loggedRuns().at(-1)).toContain("--unit=penumbra-acp-server-");
  });

  test("A3 opencode ACP server: the injected spawn receives the scoped argv", async () => {
    let captured: string[] = [];
    const err = await startAcpServer({
      cwd: root,
      opencodeBinary: "opencode",
      getPort: () => Promise.resolve(4321),
      spawn: (command, args) => {
        captured = [command, ...args];
        throw new Error("stop after spawn");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toContain("stop after spawn");
    expect(captured).toContain(fakeSystemdRun);
    expect(captured.slice(captured.indexOf("--"))).toContain("opencode");
    expect(captured.join(" ")).toContain("--unit=penumbra-acp-server-");
  });

  test("A5 isolated install: bun install runs scoped", async () => {
    let captured: string[] = [];
    await runIsolatedInstall(root, {
      timeoutMs: 1000,
      runner: (cmd, args) => {
        captured = [cmd, ...args];
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    });
    expect(captured).toContain(fakeSystemdRun);
    expect(captured.join(" ")).toContain("--unit=penumbra-install-");
    expect(captured.slice(-4)).toEqual(["bun", "install", "--ignore-scripts", "--frozen-lockfile"]);
  });
});
