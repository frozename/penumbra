import type { Mock } from "bun:test";

import { vi } from "bun:test";
import { PassThrough } from "node:stream";

import type { McpServerStdio } from "@src/adapters/acp-types.js";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import type { CapturePort } from "@src/worker/capture-port.js";

/**
 * StdioAcpHandle is a structural interface, but tests need narrower stdin/stdout
 * (PassThrough — both Writable and Readable) so they can push JSON-RPC frames
 * AND observe the agent's writes against the same object. The kill field is
 * narrowed to a Mock so tests can assert call counts without a re-cast.
 */
export interface MockAcpHandle extends Omit<
  StdioAcpHandle,
  "stdin" | "stdout" | "kill" | "getStderrTail"
> {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: Mock<() => void>;
  getStderrTail: () => string;
}

export function makeMockAcpHandle(
  init: {
    stdin?: PassThrough;
    stdout?: PassThrough;
    kill?: Mock<() => void>;
    exited?: Promise<number | null>;
    pid?: number;
    getStderrTail?: () => string;
  } = {},
): MockAcpHandle {
  return {
    stdin: init.stdin ?? new PassThrough(),
    stdout: init.stdout ?? new PassThrough(),
    kill: init.kill ?? vi.fn<() => void>(),
    exited: init.exited ?? Promise.resolve<number | null>(0),
    pid: init.pid,
    getStderrTail: init.getStderrTail ?? ((): string => ""),
  };
}

/**
 * StdioAcpClient is a class with private fields, so a structural mock requires
 * a single launder through `as unknown as`. The shape we accept matches the
 * three public methods the adapter calls.
 */
export function makeMockAcpClient(impl: {
  request: StdioAcpClient["request"];
  on: StdioAcpClient["on"];
  onRequest: StdioAcpClient["onRequest"];
}): StdioAcpClient {
  return impl as unknown as StdioAcpClient;
}

/**
 * CapturePort is a class with private state. A test capture port that only
 * needs to observe emit() calls is laundered through `as unknown as` here.
 */
export function makeMockCapturePort(impl: { emit: CapturePort["emit"] }): CapturePort {
  return impl as unknown as CapturePort;
}

/** Resolve after `ms` ms. Replaces inline `new Promise((r) => setTimeout(r, n))`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Microtask flush — replaces inline `for (let i = 0; i < n; i++) await Promise.resolve()`. */
export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

export type AcpRequestMock = Mock<(method: string, params?: unknown) => Promise<unknown>>;

interface StandardClientRequestOpts {
  sessionId?: string;
  protocolVersion?: number;
  authMethods?: unknown[];
  stopReason?: string;
  onSessionNew?: (params: unknown) => void;
  onSessionPrompt?: (params: unknown) => unknown;
  beforeInitialize?: () => Promise<void> | void;
  beforeSessionNew?: () => Promise<void> | void;
}

/**
 * Build a mock implementation for `StdioAcpClient.request` covering the
 * `initialize → session/new → session/prompt` happy path. Tests can attach a
 * hook to inspect session/new params or override session/prompt behavior.
 */
export function makeStandardClientRequest(opts: StandardClientRequestOpts = {}): AcpRequestMock {
  const sessionId = opts.sessionId ?? "session-123";
  const protocolVersion = opts.protocolVersion ?? 1;
  const authMethods = opts.authMethods ?? [];
  const stopReason = opts.stopReason ?? "end_turn";

  const fn: AcpRequestMock = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
  fn.mockImplementation(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "initialize") {
      await opts.beforeInitialize?.();
      return { protocolVersion, authMethods };
    }
    if (method === "session/new") {
      await opts.beforeSessionNew?.();
      opts.onSessionNew?.(params);
      return { sessionId };
    }
    if (method === "session/prompt") {
      if (opts.onSessionPrompt) return await opts.onSessionPrompt(params);
      return { stopReason };
    }
    return {};
  });
  return fn;
}

export type PenumbraMcpServer = McpServerStdio;

/** Shorthand for the canonical penumbra stdio mcpServer literal used in many tests. */
export function makePenumbraMcpServer(overrides: Partial<McpServerStdio> = {}): McpServerStdio {
  return {
    name: overrides.name ?? "penumbra",
    command: overrides.command ?? "bun",
    args: overrides.args ?? ["/tmp/penumbra-mcp.ts"],
    env: overrides.env ?? [],
  };
}

/** Narrow shape of session/new params used in many param-capture tests. */
export interface CapturedSessionParams {
  sessionId?: string;
  mcpServers?: McpServerStdio[];
}

/**
 * Narrow the unknown session/new params delivered by the mocked client into the
 * structural CapturedSessionParams shape tests assert against. Single cast site
 * so harness wiring doesn't repeat the assertion inline.
 */
export function asCapturedSessionParams(params: unknown): CapturedSessionParams {
  return params as CapturedSessionParams;
}

/** Cached vi.fn type that matches StdioAcpClient.request without any explicit any. */
export function makeRequestMock(): AcpRequestMock {
  return vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
}

/**
 * Box a mutable value so that writes inside callbacks don't get narrowed away
 * by TypeScript's control-flow analysis. Reading `ref.value` outside the
 * callback yields the declared type, not the initial null narrowing.
 */
export interface MutableRef<T> {
  value: T;
}

export function mutableRef<T>(initial: T): MutableRef<T> {
  return { value: initial };
}
