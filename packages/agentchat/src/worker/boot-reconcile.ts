import type { PenumbraClient } from '../penumbra-client.js';

export interface BootReconcileLogger {
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

export interface BootReconcileDeps {
  client: Pick<PenumbraClient, 'reconcileLongLivedOrphans'>;
  log: BootReconcileLogger;
  sleep?: (ms: number) => Promise<void>;
}

export async function reconcileOrphansAtWorkerBoot(deps: BootReconcileDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await deps.client.reconcileLongLivedOrphans();
      if (typeof resp?.reconciled === 'number' && resp.reconciled > 0) {
        deps.log.info({ reconciled: resp.reconciled }, 'long-lived orphan ticks reconciled at worker boot');
      }
      return;
    } catch (err) {
      if (attempt === 0) {
        deps.log.info({ err }, 'daemon not ready; retrying orphan reconcile in 2s');
        await sleep(2000);
        continue;
      }
      deps.log.warn({ err }, 'long-lived orphan reconcile call failed at worker boot; continuing');
      return;
    }
  }
}
