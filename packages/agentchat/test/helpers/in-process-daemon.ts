import {
  buildServices,
  type DispatchEventInput,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import {
  createDaemonFetchHandler,
  OrphanHandoffRecoveryService,
  ShellSessionPool,
  WatchdogService,
} from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PenumbraClient } from "@src/penumbra-client.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // best-effort: custom SQLite path may not exist on every dev machine
}

interface ShellRunInput {
  handoff_id: string;
  agent_name: string;
  session_id?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  timeout_ms?: number;
  stdin?: string;
}

interface ShellRunResult {
  session_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface CapturedRequest {
  url: string;
  body: unknown;
  status: number;
  response: unknown;
}

export interface InProcessDaemonHarness {
  client: PenumbraClient;
  services: Services;
  requests: CapturedRequest[];
  postDispatchEvent(event: DispatchEventInput): Promise<void>;
  getDispatchEvents(
    handoffId: string,
  ): Promise<{ kind: string; meta?: Record<string, unknown> | null }[]>;
  dispatchTimeline(
    handoffId: string,
  ): Promise<{ events: { kind: string; meta?: Record<string, unknown> | null }[] }>;
  shellRun(input: ShellRunInput): Promise<ShellRunResult>;
  shellClose(input: { handoff_id: string; session_id: string }): Promise<{ closed: boolean }>;
  shellRunRaw(input: ShellRunInput): Promise<Response>;
  markHandoffCompleted(handoffId: string): Promise<{ handoff_id: string; status: string }>;
  markWorkerStale(workerId: string): void;
  triggerOrphanRecovery(): { requeued: number; exhausted: number };
  stop(): Promise<void>;
}

type AgentChatConfig = NonNullable<Services["agentchatConfig"]>;
type AgentChatAgent = NonNullable<AgentChatConfig["agents"]>[number];

interface PermissionService {
  requestPermission(): Promise<{ approved: boolean }>;
}

type ServicesWithPermission = Services & { permissionService?: PermissionService };

function buildAgentChatConfig(): AgentChatConfig {
  const agents: AgentChatAgent[] = [
    { name: "claude-acp-sonnet", roles: [] },
    { name: "local-gemma26", roles: [] },
  ];
  // auto_approve_to is consumed by code paths that look at the production
  // schema; the Services view is the minimal subset, so attach the extra
  // field via Object.assign without leaking `any`.
  for (const a of agents) {
    Object.assign(a, { auto_approve_to: [] as string[] });
  }
  return { agents };
}

function buildShellSessionPool(services: Services): ShellSessionPool {
  return new ShellSessionPool({
    config: {
      enabled: true,
      maxSessionsPerHandoff: 4,
      maxConcurrentRunsPerSession: 1,
      maxSessionIdleMs: 600000,
      maxCommandDurationMs: 5000,
      outputByteLimit: 16384,
      redactOutput: true,
      unsetEnv: [],
      dangerousCommandsForAgent: () => ["sudo\\b"],
      redactOutputForAgent: () => true,
    },
    uuid: ((): (() => string) => {
      let sessionN = 0;
      return (): string => `sess-${String(++sessionN)}`;
    })(),
    handoffStatusReader: {
      getStatus: (handoffId: string): Promise<string | null> =>
        Promise.resolve(services.handoffReader.get(handoffId)?.status ?? null),
    },
  });
}

function jsonFetch<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body: unknown,
): Promise<T> {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }).then((response) => response.json() as Promise<T>);
}

function buildCapturingFetch(args: {
  handler: (req: Request) => Promise<Response>;
  requests: CapturedRequest[];
  emulateOld: boolean;
}): typeof fetch {
  const { handler, requests, emulateOld } = args;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    let body: unknown =
      req.method === "POST"
        ? await req
            .clone()
            .json()
            .catch(() => null)
        : null;
    // An old daemon's non-strict body schema silently drops claimed_before;
    // mirror that by rewriting the request before it reaches the route.
    if (
      emulateOld &&
      path === "/worker/reconcile-orphans" &&
      body !== null &&
      typeof body === "object" &&
      "claimed_before" in body
    ) {
      const stripped = { ...(body as Record<string, unknown>) };
      delete stripped["claimed_before"];
      body = stripped;
      req = new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(stripped),
      });
    }
    let res = await handler(req);
    let responseBody: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    // An old register route has no capabilities field in its response.
    if (
      emulateOld &&
      path === "/worker/register" &&
      responseBody !== null &&
      typeof responseBody === "object" &&
      "capabilities" in responseBody
    ) {
      const stripped = { ...(responseBody as Record<string, unknown>) };
      delete stripped["capabilities"];
      responseBody = stripped;
      res = Response.json(stripped, { status: res.status });
    }
    requests.push({ url: path, body, status: res.status, response: responseBody });
    return res;
  }) as typeof fetch;
}

export function startInProcessDaemon(
  opts: {
    shellEnabled?: boolean;
    autoApprovePermissions?: boolean;
    /** Wire a real OrphanHandoffRecoveryService into the route table so
     *  /worker/reconcile-orphans serves instead of returning 503. */
    orphanRecovery?: boolean;
    /** Emulate a pre-claimed_before daemon: strip the field from reconcile
     *  requests and the capability flag from register responses. */
    emulateDaemonWithoutClaimedBefore?: boolean;
  } = {},
): Promise<InProcessDaemonHarness> {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-agentchat-int-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-02T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
  });
  services.agentRegistry = ["claude-acp-sonnet", "local-gemma26"];
  // Swap the stub watchdog from buildServices for a real WatchdogService so
  // markWorkerStale (used by orphan-recovery integration tests) can poke its
  // internal heartbeat map directly.
  services.watchdog = new WatchdogService(services);
  services.watchdog.hasActiveWorker = (): boolean => true;
  services.agentchatConfig = buildAgentChatConfig();

  const shellSessionPool = opts.shellEnabled ? buildShellSessionPool(services) : undefined;
  if (shellSessionPool) {
    services.shellSessionPool = shellSessionPool;
    services.shellConfig = {
      enabled: true,
      dangerousCommandsForAgent: (): string[] => ["sudo\\b"],
    };
  }
  if (opts.autoApprovePermissions) {
    (services as ServicesWithPermission).permissionService = {
      requestPermission: (): Promise<{ approved: boolean }> => Promise.resolve({ approved: true }),
    };
  }

  const token = "tok";
  const orphanRecovery = opts.orphanRecovery
    ? new OrphanHandoffRecoveryService(services)
    : undefined;
  const handler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: orphanRecovery,
  });
  const requests: CapturedRequest[] = [];
  const fetchImpl = buildCapturingFetch({
    handler,
    requests,
    emulateOld: opts.emulateDaemonWithoutClaimedBefore === true,
  });

  writeFileSync(join(dir, "port"), "1");
  writeFileSync(join(dir, "token"), token);

  const client = new PenumbraClient({ storageRoot: dir, fetch: fetchImpl });

  const shellRun = (input: ShellRunInput): Promise<ShellRunResult> =>
    jsonFetch<ShellRunResult>(fetchImpl, "http://x/shell/run", token, input);

  return Promise.resolve({
    client,
    services,
    requests,
    postDispatchEvent: (event): Promise<void> => client.postDispatchEvents([event]),
    getDispatchEvents: async (
      handoffId,
    ): Promise<{ kind: string; meta?: Record<string, unknown> | null }[]> => {
      const { events } = await client.getDispatchEvents({ handoff_id: handoffId });
      return events;
    },
    dispatchTimeline: (
      handoffId,
    ): Promise<{ events: { kind: string; meta?: Record<string, unknown> | null }[] }> =>
      client.getDispatchTimeline(handoffId) as Promise<{
        events: { kind: string; meta?: Record<string, unknown> | null }[];
      }>,
    shellRun,
    shellClose: (input): Promise<{ closed: boolean }> =>
      jsonFetch<{ closed: boolean }>(fetchImpl, "http://x/shell/close", token, input),
    shellRunRaw: (input): Promise<Response> =>
      fetchImpl("http://x/shell/run", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    markHandoffCompleted: (handoffId): Promise<{ handoff_id: string; status: string }> =>
      client.completeHandoff(handoffId),
    markWorkerStale: (workerId): void => {
      // Force-age the worker's heartbeat so OrphanHandoffRecoveryService treats it as stale.
      (services.watchdog as unknown as { lastHeartbeats: Map<string, number> }).lastHeartbeats.set(
        workerId,
        0,
      );
    },
    triggerOrphanRecovery: (): { requeued: number; exhausted: number } => {
      // staleMs=1 with the past-epoch heartbeat from markWorkerStale guarantees the worker shows stale.
      const recovery = new OrphanHandoffRecoveryService(services, {
        intervalMs: 0,
        staleMs: 1,
        batchSize: 100,
      });
      return recovery.runOnce();
    },
    stop: async (): Promise<void> => {
      try {
        if (shellSessionPool) {
          await shellSessionPool.shutdown();
        }
        services.supervisor.stopAll();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
}
