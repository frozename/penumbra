import { getJobResourceEnv, type JobResourceEnv } from "@penumbra/config";
import {
  createHeavyJobGate,
  type HeavyJobGate,
  HeavyJobLock,
  type Logger,
  primeResourceScope,
  resolveAdmitMinGiB,
  type ResourceScopeDetection,
  waitForMemory,
  type WaitForMemoryOptions,
} from "@penumbra/core";

export interface WorkerJobResources {
  scope: ResourceScopeDetection;
  /** Host-wide serialization + memory admission for heavy reconciler stages. */
  heavyStageGate: HeavyJobGate;
  /** Dispatcher admission: false leaves the handoff unclaimed. */
  admitClaim: (handoff: { handoff_id: string }, signal: AbortSignal) => Promise<boolean>;
}

export interface WorkerJobResourcesDeps {
  env?: NodeJS.ProcessEnv;
  prime?: () => Promise<ResourceScopeDetection>;
  lock?: HeavyJobLock;
  memory?: Omit<WaitForMemoryOptions, "onWait" | "signal" | "timeoutMs">;
}

export async function setupWorkerJobResources(
  log: Logger,
  deps: WorkerJobResourcesDeps = {},
): Promise<WorkerJobResources> {
  const jobEnv: JobResourceEnv = getJobResourceEnv(deps.env ?? process.env);
  const scope = await (
    deps.prime ?? ((): Promise<ResourceScopeDetection> => primeResourceScope())
  )();
  const admitMinGiB = await resolveAdmitMinGiB(jobEnv.admitMinGiB, deps.memory);
  log.info(
    {
      admit_min_gib: Number(admitMinGiB.toFixed(1)),
      explicit: jobEnv.admitMinGiB !== undefined,
      admit_wait_s: jobEnv.admitWaitS,
    },
    "job memory admission floor",
  );
  const waitMs = jobEnv.admitWaitS * 1000;
  const heavyStageGate = createHeavyJobGate({
    lock: deps.lock ?? new HeavyJobLock({ path: jobEnv.heavyLockPath, log }),
    admitMinGiB,
    waitMs,
    log,
    memory: deps.memory,
  });
  const admitClaim = async (
    handoff: { handoff_id: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const admission = await waitForMemory(admitMinGiB, {
      ...deps.memory,
      timeoutMs: waitMs,
      signal,
      onWait: (availableGiB) => {
        log.info(
          {
            handoff_id: handoff.handoff_id,
            available_gib: Number(availableGiB.toFixed(1)),
            min_gib: Number(admitMinGiB.toFixed(1)),
          },
          "dispatch waiting for host memory admission before claim",
        );
      },
    });
    return admission.admitted;
  };
  return { scope, heavyStageGate, admitClaim };
}
