import type { Services } from '@penumbra/core';
import { T1Rollup, ContextFileWriter } from '@penumbra/core';

export interface RollupWorkerOpts {
  services: Services;
  idleMinutes: number;
  topK?: number;
}

export function createRollupWorker(opts: RollupWorkerOpts) {
  const t1 = new T1Rollup({
    db: opts.services.db,
    embedder: opts.services.embedder,
    clock: opts.services.clock,
    uuid: opts.services.uuid,
  });
  const ctx = new ContextFileWriter({
    db: opts.services.db,
    storageRoot: opts.services.storageRoot,
    topK: opts.topK ?? 10,
  });
  return {
    async tick(): Promise<void> {
      const sessions = t1.detectIdleSessions(opts.idleMinutes, opts.services.clock());
      for (const sessionId of sessions) {
        try {
          const id = await t1.rollupSession(sessionId);
          if (id) {
            const projectRow = opts.services.db
              .query<{ project_id: string | null }, [string]>(
                'SELECT project_id FROM t1_rollups WHERE rollup_id=?',
              )
              .get(id);
            if (projectRow?.project_id) ctx.rewrite(projectRow.project_id);
          }
        } catch (err) {
          opts.services.log.warn({ sessionId, err }, 'rollup worker: session failed, skipping');
        }
      }
    },
  };
}
