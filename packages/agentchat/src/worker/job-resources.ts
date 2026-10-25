import { getJobResourceEnv, type JobResourceEnv } from "@penumbra/config";
import {
  createHeavyJobGate,
  type HeavyJobGate,
  HeavyJobLock,
  type Logger,
  primeResourceScope,
  readMemAvailableGiB,
  resolveAdmitMinGiB,
  type ResourceScopeDetection,
  waitForMemory,
  type WaitForMemoryOptions,
} from "@penumbra/core";

export const ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG =
  "host MemAvailable is below the derived claim admission floor; claims may never be admitted. Set PENUMBRA_JOB_ADMIT_MIN_GIB to change the floor";
export const CLAIM_ADMISSION_TIMEOUT_MSG = "host memory admission timeout: claim not admitted";

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
  if (jobEnv.admitMinGiB === undefined && admitMinGiB > 0) {
    const availableAtBoot = await readMemAvailableGiB(deps.memory);
    if (availableAtBoot !== null && availableAtBoot < admitMinGiB) {
      log.warn(
        {
          admit_min_gib: Number(admitMinGiB.toFixed(1)),
          available_gib: Number(availableAtBoot.toFixed(1)),
          explicit: false,
          env_var: "PENUMBRA_JOB_ADMIT_MIN_GIB",
        },
        ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG,
      );
    }
  }
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
    if (!admission.admitted && admission.reason === "timeout") {
      log.warn(
        {
          handoff_id: handoff.handoff_id,
          available_gib:
            admission.availableGiB === null ? null : Number(admission.availableGiB.toFixed(1)),
          min_gib: Number(admitMinGiB.toFixed(1)),
          waited_s: Math.round(admission.waitedMs / 1000),
          explicit: jobEnv.admitMinGiB !== undefined,
          env_var: "PENUMBRA_JOB_ADMIT_MIN_GIB",
        },
        CLAIM_ADMISSION_TIMEOUT_MSG,
      );
    }
    return admission.admitted;
  };
  return { scope, heavyStageGate, admitClaim };
}
