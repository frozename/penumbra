/**
 * Runnable infra-host smoke: proves the packed artifact resolves inside this
 * consumer's own node_modules (never a workspace link or sibling checkout),
 * then drives a real spawn and a real fake-acp ACP session over it.
 * Run with `bun src/smoke.ts` from the installed consumer copy.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as primitives from "penumbra-exec-primitives";

import { bootAcpSession } from "./acp.ts";
import { spawnFn } from "./spawn.ts";

const REQUIRED_EXPORTS = [
  "AcpResponseError",
  "AcpTransportClosedError",
  "HostInputError",
  "StdioAcpClient",
  "StdioAcpPermissionContext",
  "createAcpWarmPool",
  "detectCapacityError",
  "handleStdioAcpPermissionRequest",
  "initializeAcpSession",
  "poolKeyFor",
  "runProcess",
  "selectConfigOption",
  "selectTrustAllOption",
  "startStdioAcpServer",
  "superviseProcess",
] as const;

for (const name of REQUIRED_EXPORTS) {
  const value = (primitives as Record<string, unknown>)[name];
  if (typeof value !== "function" && typeof value !== "object") {
    throw new Error(`penumbra-exec-primitives export missing: ${name}`);
  }
}

// The packed artifact must resolve inside this consumer's own node_modules —
// a workspace sibling or repo checkout would mask a broken install.
const consumerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const resolvedSpecifier = import.meta.resolve("penumbra-exec-primitives");
const resolvedEntry = realpathSync(
  resolvedSpecifier.startsWith("file:") ? fileURLToPath(resolvedSpecifier) : resolvedSpecifier,
);
const expectedPrefix = `${realpathSync(consumerRoot)}${sep}node_modules${sep}`;
if (!resolvedEntry.startsWith(expectedPrefix) || resolvedEntry.includes("packages/")) {
  throw new Error(`penumbra-exec-primitives resolved outside this consumer: ${resolvedEntry}`);
}
const pkgDir = join(consumerRoot, "node_modules", "penumbra-exec-primitives");
const pkgStat = lstatSync(pkgDir);
if (!pkgStat.isDirectory() || pkgStat.isSymbolicLink()) {
  throw new Error(`installed package must be a real directory, not a symlink: ${pkgDir}`);
}

const cwd = dirname(fileURLToPath(import.meta.url));
const fixture = join(cwd, "..", "fixtures", "fake-acp.mjs");
const signal = new AbortController().signal;

const echo = await spawnFn(["sh", "-c", 'printf "infra-smoke"'], process.env, cwd, {
  signal,
  deadline: 5_000,
});
if (echo.stdout !== "infra-smoke") {
  throw new Error(`spawnFn returned unexpected stdout: ${JSON.stringify(echo.stdout)}`);
}

const booted = await bootAcpSession(fixture, process.env, cwd, { signal });
try {
  const promptResult = (await booted.client.request("session/prompt", {
    sessionId: booted.session.sessionId,
    prompt: [{ type: "text", text: "smoke" }],
  })) as { stopReason?: string };
  if (promptResult.stopReason !== "end_turn") {
    throw new Error(`unexpected stopReason: ${JSON.stringify(promptResult)}`);
  }
} finally {
  booted.handle.kill();
  await booted.handle.exited;
}

console.log("infra-host smoke: OK");
