import type { PenumbraClient } from '../penumbra-client.js';

export interface BootReconcileLogger {
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

export interface BootReconcileDeps {
  client: Pick<PenumbraClient, 'reconcileLongLivedOrphans' | 'reconcileDispatchOrphans' | 'postHeartbeat'>;
  log: BootReconcileLogger;
  workerId: string;
  sleep?: (ms: number) => Promise<void>;
}

export async function reconcileOrphansAtWorkerBoot(deps: BootReconcileDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // 1. Heartbeat
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.client.postHeartbeat(deps.workerId);
      break;
    } catch (err) {
      if (attempt === 0) {
        deps.log.info({ err }, 'daemon not ready; retrying heartbeat in 2s');
        await sleep(2000);
        continue;
      }
      deps.log.warn({ err }, 'heartbeat call failed at worker boot; continuing');
    }
  }

  // 2. Long-lived orphans
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await deps.client.reconcileLongLivedOrphans();
      if (typeof resp?.reconciled === 'number' && resp.reconciled > 0) {
        deps.log.info({ reconciled: resp.reconciled }, 'long-lived orphan ticks reconciled at worker boot');
      }
      break;
    } catch (err) {
      if (attempt === 0) {
        deps.log.info({ err }, 'daemon not ready; retrying long-lived orphan reconcile in 2s');
        await sleep(2000);
        continue;
      }
      deps.log.warn({ err }, 'long-lived orphan reconcile call failed at worker boot; continuing');
    }
  }

  // 3. Dispatch orphans
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await deps.client.reconcileDispatchOrphans(deps.workerId);
      if (typeof resp?.requeued === 'number' && (resp.requeued > 0 || resp.exhausted > 0)) {
        deps.log.info({ requeued: resp.requeued, exhausted: resp.exhausted }, 'dispatch orphans reconciled at worker boot');
      }
      return;
    } catch (err) {
      if (attempt === 0) {
        deps.log.info({ err }, 'daemon not ready; retrying dispatch orphan reconcile in 2s');
        await sleep(2000);
        continue;
      }
      deps.log.warn({ err }, 'dispatch orphan reconcile call failed at worker boot; continuing');
      return;
    }
  }
}
