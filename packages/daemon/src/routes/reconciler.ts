import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { createGhCliClient, createGitCliClient, runPrOrphanSweep } from '../sweepers/pr-orphan-sweeper.js';

const SweepInputSchema = z.object({
  dry_run: z.boolean().optional(),
  max_close: z.number().int().positive().optional(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function reconcilerSweepOrphanPrsRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = SweepInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }

  const daemonSettings = services.settings as any;
  const ghClient = createGhCliClient();
  const gitClient = createGitCliClient();
  const result = await runPrOrphanSweep({
    ghClient,
    gitClient,
    t0Writer: services.t0Writer,
    uuid: services.uuid,
    clock: services.clock,
    machineId: services.machineId,
    dryRun: parsed.data.dry_run ?? (daemonSettings.prOrphanSweeperDryRun ?? true),
    maxClose: parsed.data.max_close,
    log: services.log as any,
    projectId: null,
  });

  return json(result);
}
