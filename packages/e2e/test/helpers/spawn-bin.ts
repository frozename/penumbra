import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess, SpawnOptions } from "bun";

export type BunSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const REPO_ROOT = (() => {
  // Resolve the repo root from this file's location:
  // packages/e2e/test/helpers/spawn-bin.ts → ../../../../
  const here = new URL(".", import.meta.url).pathname;
  return join(here, "..", "..", "..", "..");
})();

/** Absolute path to the penumbra CLI bin. */
export const PENUMBRA_BIN = join(REPO_ROOT, "packages/cli/bin/penumbra.ts");
/** Absolute path to the penumbra-mcp stdio bin. */
export const PENUMBRA_MCP_BIN = join(REPO_ROOT, "packages/mcp/bin/penumbra-mcp.ts");

const childRegistry = new Set<BunSubprocess>();

process.on("exit", () => {
  for (const c of childRegistry) {
    try {
      c.kill();
    } catch {
      /* already dead */
    }
  }
});

/**
 * Spawn `bun <args>` with all stdio piped. Tracks the child for emergency
 * cleanup on test-process exit.
 */
export function spawnBun(args: string[], env?: Record<string, string | undefined>): BunSubprocess {
  const opts: SpawnOptions.SpawnOptions<"pipe", "pipe", "pipe"> & { cmd: string[] } = {
    cmd: ["bun", ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  };
  if (env) opts.env = { ...process.env, ...env } as Record<string, string>;
  const proc = Bun.spawn(opts) as BunSubprocess;
  childRegistry.add(proc);
  return proc;
}

/**
 * Spawn the Penumbra CLI bin with the given subcommand args.
 * Sets PENUMBRA_STORAGE_ROOT from `storageRoot`.
 */
export function spawnPenumbra(
  cliArgs: string[],
  storageRoot: string,
  extraEnv: Record<string, string | undefined> = {},
): BunSubprocess {
  return spawnBun([PENUMBRA_BIN, ...cliArgs], {
    PENUMBRA_STORAGE_ROOT: storageRoot,
    ...extraEnv,
  });
}

/**
 * Spawn the penumbra-mcp stdio bin with PENUMBRA_STORAGE_ROOT set.
 */
export function spawnPenumbraMcp(
  storageRoot: string,
  extraEnv: Record<string, string | undefined> = {},
): BunSubprocess {
  return spawnBun([PENUMBRA_MCP_BIN], {
    PENUMBRA_STORAGE_ROOT: storageRoot,
    ...extraEnv,
  });
}

/**
 * Wait for `<dir>/port` to exist and contain a valid port number.
 * Polls every 100ms up to `timeoutMs`. Resolves with the port number.
 */
export async function waitForPortFile(dir: string, timeoutMs = 5000): Promise<number> {
  const portPath = join(dir, "port");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portPath)) {
      const raw = readFileSync(portPath, "utf8").trim();
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitForPortFile: timeout after ${timeoutMs}ms (no valid port at ${portPath})`);
}

/**
 * Drain stdout + stderr of a subprocess into strings. Awaits exit.
 */
export async function captureOutput(
  proc: BunSubprocess,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  childRegistry.delete(proc);
  return { exitCode, stdout, stderr };
}

/**
 * Drain stdout + stderr of a long-running subprocess to discard, in the
 * background. Prevents the OS pipe buffer (typically 64KiB) from filling
 * up and back-pressuring the child into a write-deadlock.
 *
 * Use this for "daemon-as-background-child" patterns where the test waits
 * on a side effect (port file, log, exit code) rather than on stdout.
 */
export function drainOutput(proc: BunSubprocess): void {
  void (async () => {
    try {
      const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* subprocess died, that's fine */
    }
  })();
  void (async () => {
    try {
      const reader = (proc.stderr as unknown as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* subprocess died, that's fine */
    }
  })();
}

/**
 * Send SIGTERM to a child, give it `gracefulMs` to exit, then SIGKILL.
 */
export async function killGracefully(proc: BunSubprocess, gracefulMs = 2000): Promise<number> {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), gracefulMs),
  );
  const result = await Promise.race([proc.exited, timeout]);
  if (result === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    await proc.exited;
  }
  childRegistry.delete(proc);
  return proc.exitCode ?? -1;
}
