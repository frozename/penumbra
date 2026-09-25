/**
 * Runnable infra-host smoke (plain JS, node-compatible): namespace resolution
 * + a real fake-acp session over the packed artifact.
 * Run with `node src/smoke.mjs` or `bun src/smoke.mjs`.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as primitives from "penumbra-exec-primitives";

import { bootAcpSession } from "./acp.mjs";
import { spawnFn } from "./spawn.mjs";

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
];

for (const name of REQUIRED_EXPORTS) {
  const value = primitives[name];
  if (typeof value !== "function" && typeof value !== "object") {
    throw new Error(`penumbra-exec-primitives export missing: ${name}`);
  }
}

const cwd = dirname(fileURLToPath(import.meta.url));
const fixture = join(cwd, "..", "fixtures", "fake-acp.mjs");
const signal = new AbortController().signal;

const echo = await spawnFn(["sh", "-c", 'printf "infra-smoke"'], process.env, cwd, { signal });
if (echo.stdout !== "infra-smoke") {
  throw new Error(`spawnFn returned unexpected stdout: ${JSON.stringify(echo.stdout)}`);
}

const booted = await bootAcpSession(fixture, process.env, cwd, { signal });
try {
  const promptResult = await booted.client.request("session/prompt", {
    sessionId: booted.session.sessionId,
    prompt: [{ type: "text", text: "smoke" }],
  });
  if (promptResult.stopReason !== "end_turn") {
    throw new Error(`unexpected stopReason: ${JSON.stringify(promptResult)}`);
  }
} finally {
  booted.handle.kill();
  await booted.handle.exited;
}

console.log("infra-host smoke: OK");
