import type { Services } from "@penumbra/core";

import {
  createGitCliClient,
  type PrSweepResult,
  runPrOrphanSweep,
  type GhClient as SweepGhClient,
} from "../sweepers/pr-orphan-sweeper.js";
import { createGhCliClient } from "./gh-client.js";

export async function runPrOrphanSweepForDaemon(input: {
  services: Services;
  dryRun: boolean;
  maxClose?: number;
}): Promise<PrSweepResult> {
  const ghClient = createGhCliClient();
  const gitClient = createGitCliClient();
  const { services } = input;
  return await runPrOrphanSweep({
    ghClient: ghClient as unknown as SweepGhClient,
    gitClient,
    t0Writer: services.t0Writer,
    uuid: services.uuid,
    clock: services.clock,
    machineId: services.machineId,
    dryRun: input.dryRun,
    maxClose: input.maxClose,
    log: services.log,
    projectId: null,
  });
}
