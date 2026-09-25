import {
  type ExecLogger,
  HostInputError,
  requireFiniteMs,
  requireNonEmptyString,
  requireSignal,
} from "./host.js";
import { AcpResponseError, type StdioAcpClient } from "./stdio-acp-client.js";

const AUTH_REQUIRED_CODE = -32000;

export interface AcpSessionClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
}

export interface InitializeAcpSessionOptions {
  client: AcpSessionClient | StdioAcpClient;
  /** Host identity advertised on the wire — required verbatim. */
  clientInfo: unknown;
  clientCapabilities?: unknown;
  protocolVersion?: number;
  cwd: string;
  mcpServers?: unknown[];
  signal: AbortSignal;
  /** Total wall-clock budget for the whole bootstrap, in milliseconds. */
  bootDeadlineMs: number;
  /**
   * Invoked when session/new fails with AUTH_REQUIRED. Receives the
   * authMethods array from the initialize result; return the methodId to
   * authenticate with, or null to reject the bootstrap.
   */
  selectAuthMethod?: (authMethods: unknown[]) => string | null | undefined;
  logger?: ExecLogger;
}

export interface AcpSession {
  sessionId: string;
  agentCapabilities: unknown;
  authMethods: unknown[];
  protocolVersion: number;
}

function abortError(): Error {
  return new Error("acp-session: bootstrap aborted");
}

function raceDeadline<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  method: string,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error(`acp-session: boot deadline exceeded before ${method}`));
  }
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`acp-session: boot deadline exceeded during ${method}`));
    }, remaining);
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function initializeAcpSession(opts: InitializeAcpSessionOptions): Promise<AcpSession> {
  if (opts.clientInfo === undefined || opts.clientInfo === null) {
    throw new HostInputError("clientInfo", "host must advertise its identity verbatim");
  }
  const cwd = requireNonEmptyString(opts.cwd, "cwd");
  const signal = requireSignal(opts.signal, "signal");
  const bootDeadlineMs = requireFiniteMs(opts.bootDeadlineMs, "bootDeadlineMs", { min: 1 });
  const clientValue: unknown = opts.client;
  if (
    typeof clientValue !== "object" ||
    clientValue === null ||
    typeof (clientValue as AcpSessionClient).request !== "function"
  ) {
    throw new HostInputError("client", "expected an ACP client with a request method");
  }
  const client = clientValue as AcpSessionClient;
  const protocolVersion = opts.protocolVersion ?? 1;
  const deadlineAt = Date.now() + bootDeadlineMs;

  const initResult = (await raceDeadline(
    client.request("initialize", {
      protocolVersion,
      clientCapabilities: opts.clientCapabilities ?? {},
      clientInfo: opts.clientInfo,
    }),
    signal,
    deadlineAt,
    "initialize",
  )) as {
    agentCapabilities?: unknown;
    authMethods?: unknown;
    protocolVersion?: unknown;
  };
  const authMethods = Array.isArray(initResult.authMethods) ? initResult.authMethods : [];

  const newSession = (): Promise<unknown> =>
    raceDeadline(
      client.request("session/new", { cwd, mcpServers: opts.mcpServers ?? [] }),
      signal,
      deadlineAt,
      "session/new",
    );

  let newResult: unknown;
  try {
    newResult = await newSession();
  } catch (err) {
    if (!(err instanceof AcpResponseError) || err.code !== AUTH_REQUIRED_CODE) throw err;
    const methodId = opts.selectAuthMethod?.(authMethods);
    if (typeof methodId !== "string" || methodId.length === 0) {
      throw new Error("acp-session: authentication required and no auth method selected");
    }
    await raceDeadline(
      client.request("authenticate", { methodId }),
      signal,
      deadlineAt,
      "authenticate",
    );
    newResult = await newSession();
  }

  const sessionId =
    typeof newResult === "object" && newResult !== null
      ? (newResult as { sessionId?: unknown }).sessionId
      : undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("acp-session: session/new returned no sessionId");
  }
  return {
    sessionId,
    agentCapabilities: initResult.agentCapabilities,
    authMethods,
    protocolVersion:
      typeof initResult.protocolVersion === "number" ? initResult.protocolVersion : protocolVersion,
  };
}
