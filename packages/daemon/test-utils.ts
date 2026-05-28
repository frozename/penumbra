export { serve, createDaemonFetchHandler, type ServeOpts, type DaemonHandle } from "./src/serve.js";
export { ShellSessionPool } from "./src/services/shell-session-pool.js";
export { OrphanHandoffRecoveryService } from "./src/services/orphan-handoff-recovery.js";
export { WatchdogService } from "./src/services/watchdog.js";

export interface RegisterWorkerForTestArgs {
  baseUrl: string;
  sharedBearer: string;
  worker_id: string;
  metadata?: Record<string, unknown>;
  fetcher?: typeof fetch;
}

export interface RegisterWorkerForTestResult {
  worker_token: string;
  worker_id: string;
}

export async function registerWorkerForTest(
  args: RegisterWorkerForTestArgs,
): Promise<RegisterWorkerForTestResult> {
  const fetcher = args.fetcher ?? fetch;
  const res = await fetcher(`${args.baseUrl}/worker/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.sharedBearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ worker_id: args.worker_id, metadata: args.metadata }),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new Error(`registerWorkerForTest: HTTP ${res.status}: ${JSON.stringify(errorBody)}`);
  }
  return (await res.json()) as RegisterWorkerForTestResult;
}
