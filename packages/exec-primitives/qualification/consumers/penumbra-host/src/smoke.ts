/**
 * Consumer smoke: prove the packed artifact resolves inside this consumer's
 * own node_modules (never a workspace link or sibling checkout), then drive a
 * real process through the shim surface and a real fake-acp ACP session over
 * the packed client. The deep wire behavior is covered by the parity suite;
 * this file is the "can the host import and run it" check.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  initializeAcpSession,
  startStdioAcpServer,
  StdioAcpClient,
  type StdioAcpHandle,
} from "penumbra-exec-primitives";
import * as primitives from "penumbra-exec-primitives";

import { spawnCliAdapter } from "./shim/cli-spawn.js";

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

const out = await spawnCliAdapter({
  command: "sh",
  args: ["-c", 'printf "smoke-ok"'],
  prompt: "",
  signal: new AbortController().signal,
  pass_via: "argv",
});
if (out.text !== "smoke-ok") {
  throw new Error(`smoke run returned unexpected text: ${JSON.stringify(out.text)}`);
}

// A real ACP session over the packed server+client against the fake fixture.
const fixture = join(consumerRoot, "fixtures", "fake-acp.mjs");
const ac = new AbortController();
const handle: StdioAcpHandle = await startStdioAcpServer({
  command: process.execPath,
  args: [fixture],
  cwd: consumerRoot,
  env: { PATH: process.env["PATH"] ?? "" },
  signal: ac.signal,
  cancelGraceMs: 500,
  stderrTailBytes: 4 * 1024,
});
const client = new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout });
const session = await initializeAcpSession({
  client,
  clientInfo: { name: "penumbra-host-smoke", version: "0.0.1" },
  clientCapabilities: { fs: { readTextFile: false }, terminal: false },
  protocolVersion: 1,
  cwd: consumerRoot,
  signal: ac.signal,
  bootDeadlineMs: 10_000,
  selectAuthMethod: () => "env",
});
try {
  const promptResult = (await client.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "smoke" }],
  })) as { stopReason?: string };
  if (promptResult.stopReason !== "end_turn") {
    throw new Error(`unexpected stopReason: ${JSON.stringify(promptResult)}`);
  }
} finally {
  handle.kill();
  await handle.exited;
}

console.log("penumbra-host smoke: OK");
