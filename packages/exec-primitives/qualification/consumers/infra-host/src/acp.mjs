/**
 * Infra-host ACP surface (plain JS): boots a fake ACP peer through the packed
 * startStdioAcpServer → StdioAcpClient → initializeAcpSession path, and builds
 * credential-scoped warm-pool specs. credentialScope is derived from the
 * allowlisted child env so two tenants never share a pooled process.
 */
import { createHash } from "node:crypto";

import {
  createAcpWarmPool,
  initializeAcpSession,
  poolKeyFor,
  startStdioAcpServer,
  StdioAcpClient,
} from "penumbra-exec-primitives";

import { buildChildEnv, SPAWN_BINDING } from "./spawn.mjs";

export const ACP_CLIENT_INFO = { name: "infra-host-smoke", version: "0.0.1" };
export const ACP_CLIENT_CAPABILITIES = { fs: { readTextFile: true }, terminal: false };
export const ACP_PROTOCOL_VERSION = 1;
export const BOOT_DEADLINE_MS = 10_000;
export const ACP_STDERR_TAIL_BYTES = 4 * 1024;

/**
 * Scope warm-pool entries by the exact allowlisted env the child sees —
 * the full sha256 hex of the sorted "name=value" lines (never truncated).
 */
export function credentialScopeFor(env) {
  const childEnv = buildChildEnv(env);
  const serialized = Object.keys(childEnv)
    .sort()
    .map((key) => `${key}=${childEnv[key] ?? ""}`)
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex");
}

export function acpSpecFor(env, cwd, agent = "fake-acp") {
  return {
    agent,
    cwd,
    credentialScope: credentialScopeFor(env),
    specHash: JSON.stringify([agent, cwd]),
  };
}

export function createPool() {
  return createAcpWarmPool({ sweepIntervalMs: 60_000, graceMs: 60_000, maxAgeMs: 3_600_000 });
}

/** Boot a fake-acp child and run the full initialize → session/new handshake. */
export async function bootAcpSession(fixturePath, env, cwd, opts) {
  const childEnv = buildChildEnv(env);
  if (opts.requireAuth === true) childEnv["FAKE_ACP_REQUIRE_AUTH"] = "1";
  if (opts.askPermission === true) childEnv["FAKE_ACP_ASK_PERMISSION"] = "1";
  if (opts.echoEnv === true) childEnv["FAKE_ACP_ECHO_ENV"] = "1";
  if (opts.logPath !== undefined) childEnv["FAKE_ACP_LOG"] = opts.logPath;
  const handle = await startStdioAcpServer({
    command: opts.runtime ?? process.execPath,
    args: [fixturePath],
    cwd,
    env: childEnv,
    signal: opts.signal,
    cancelGraceMs: SPAWN_BINDING.cancelGraceMs,
    stderrTailBytes: ACP_STDERR_TAIL_BYTES,
  });
  const client = new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout });
  const session = await initializeAcpSession({
    client,
    clientInfo: ACP_CLIENT_INFO,
    clientCapabilities: ACP_CLIENT_CAPABILITIES,
    protocolVersion: ACP_PROTOCOL_VERSION,
    cwd,
    signal: opts.signal,
    bootDeadlineMs: BOOT_DEADLINE_MS,
    selectAuthMethod: (authMethods) => {
      const first = authMethods[0];
      return typeof first === "object" && first !== null ? first.id : undefined;
    },
  });
  return { handle, client, session };
}

export function poolKeyOf(env, cwd, agent = "fake-acp") {
  return poolKeyFor(acpSpecFor(env, cwd, agent));
}
