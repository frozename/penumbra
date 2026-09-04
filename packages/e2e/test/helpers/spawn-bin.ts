import type { Subprocess } from "bun";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BunSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const REPO_ROOT: string = ((): string => {
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
 * Build an environment for a spawned child that keeps global/user-level state
 * inside the test sandbox instead of leaking into the developer's real home,
 * and is hermetic against ambient operator env.
 *
 * We deliberately do NOT override `HOME`: that is a blunt instrument that also
 * rewrites git global config discovery (`~/.gitconfig`), Bun module cache
 * lookup paths, and other legitimate home-directory dependencies. Instead, we
 * point the specific penumbra paths that `penumbra init` and the daemon write
 * to at the variables that already control them:
 *
 * - `AGENTCHAT_CONFIG` -> `<storageRoot>/home/.config/agentchat/agentchat.yaml`
 * - `PENUMBRA_CONFIG_DIR` -> `<storageRoot>/home/.config/penumbra`
 * - `PENUMBRA_CLAUDE_USER_DIR` -> `<storageRoot>/home/.claude`
 *
 * We also redirect Bun's runtime transpiler cache (`BUN_RUNTIME_TRANSPILER_CACHE_PATH`)
 * under the same synthetic home so the child does not write back to the real
 * `~/Library/Caches/bun` (or equivalent).
 *
 * The trap this guards: this suite frequently runs under a live penumbra
 * worker whose environment carries operator overrides
 * (`PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID`,
 * `PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID`, `PENUMBRA_WORKER_PROJECT_ID`,
 * ...). A plain `{ ...process.env, ...env }` merge leaks all of them into the
 * child under test -- e.g. the require-explicit-project-id gates reject a
 * `chain_start` whose sandbox cwd is not registered as a project. Scrub every
 * ambient `PENUMBRA_*` / `AGENTCHAT_*` variable instead: the child sees only
 * what the test explicitly sets (plus the redirects above). If a test needs
 * one of these variables, pass it via `env`.
 */
function buildSandboxEnv(
  env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PENUMBRA_") || key.startsWith("AGENTCHAT_")) continue;
    merged[key] = value;
  }
  Object.assign(merged, env);
  const storageRoot = merged.PENUMBRA_STORAGE_ROOT;
  if (typeof storageRoot !== "string" || storageRoot.length === 0) {
    return merged;
  }
  const home = join(storageRoot, "home");
  merged.AGENTCHAT_CONFIG ??= join(home, ".config", "agentchat", "agentchat.yaml");
  merged.PENUMBRA_CONFIG_DIR ??= join(home, ".config", "penumbra");
  merged.PENUMBRA_CLAUDE_USER_DIR ??= join(home, ".claude");
  merged.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??= join(home, "Library", "Caches", "bun");
  return merged;
}

/**
 * Spawn `bun <args>` with all stdio piped. Tracks the child for emergency
 * cleanup on test-process exit.
 */
export function spawnBun(args: string[], env?: Record<string, string | undefined>): BunSubprocess {
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(env !== undefined ? { env: buildSandboxEnv(env) } : {}),
  });
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
    // Scrub any ambient allowlist so MCP boot oracles see the full tool surface.
    PENUMBRA_MCP_TOOL_ALLOWLIST: undefined,
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
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `waitForPortFile: timeout after ${String(timeoutMs)}ms (no valid port at ${portPath})`,
  );
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

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } catch {
    /* subprocess died, that's fine */
  }
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
  void drainStream(proc.stdout);
  void drainStream(proc.stderr);
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
    setTimeout(() => {
      resolve("timeout");
    }, gracefulMs),
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
