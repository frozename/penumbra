import type { Services } from "@penumbra/core";
import {
  createGitCliClient,
  runPrOrphanSweep,
  type GhClient as PrOrphanGhClient,
  type PrSweepResult,
} from "../sweepers/pr-orphan-sweeper.js";
import { createGhCliClient } from "./gh-client.js";

export async function runPrOrphanSweepForDaemon(input: {
  services: Services;
  dryRun: boolean;
  maxClose?: number;
}): Promise<PrSweepResult> {
  const ghClient = createGhCliClient() as PrOrphanGhClient;
  const gitClient = createGitCliClient();
  const { services } = input;
  return runPrOrphanSweep({
    ghClient,
    gitClient,
    t0Writer: services.t0Writer,
    uuid: services.uuid,
    clock: services.clock,
    machineId: services.machineId,
    dryRun: input.dryRun,
    maxClose: input.maxClose,
    log: services.log as any,
    projectId: null,
  });
}
