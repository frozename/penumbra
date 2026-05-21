import type { PenumbraClient } from './penumbra-client.js';
import { reconcileOrphansAtWorkerBoot, type BootReconcileLogger } from './worker/boot-reconcile.js';

export interface WorkerBootLogger extends BootReconcileLogger {
  error(meta: Record<string, unknown>, msg: string): void;
}

export async function runWorkerBoot(args: {
  client: Pick<PenumbraClient, 'registerWorker' | 'postHeartbeat' | 'reconcileDispatchOrphans' | 'reconcileLongLivedOrphans'>;
  log: WorkerBootLogger;
  workerId: string;
  workerMetadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await args.client.registerWorker({ worker_id: args.workerId, metadata: args.workerMetadata });
  } catch (err) {
    args.log.error({ err }, 'worker registration failed; aborting boot');
    throw err;
  }
  await reconcileOrphansAtWorkerBoot({ client: args.client, log: args.log, workerId: args.workerId });
}
