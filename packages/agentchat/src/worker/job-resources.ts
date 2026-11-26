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
export const HEAVY_LOCK_IN_PROCESS_ONLY_MSG =
  'heavy-job lock is in-process only (no flock(1) on PATH, /usr/bin or /bin, and crossProcessFallback is "none"): heavy stages are serialized only inside this worker process, not across workers or other penumbra processes';
/** Matches the 900 s default admission wait: a stuck host is re-checked, not polled. */
export const ADMISSION_FLOOR_RECHECK_INTERVAL_MS = 15 * 60_000;

export interface WorkerJobResources {
  scope: ResourceScopeDetection;
  /** Host-wide serialization + memory admission for heavy reconciler stages. */
  heavyStageGate: HeavyJobGate;
  /** Dispatcher admission: false leaves the handoff unclaimed. */
  admitClaim: (handoff: { handoff_id: string }, signal: AbortSignal) => Promise<boolean>;
  /**
   * Re-warns while a *derived* admission floor sits above host MemAvailable, so
   * an operator sees a permanently unreachable floor long after boot. Throttled
   * to ADMISSION_FLOOR_RECHECK_INTERVAL_MS and a no-op for an explicit floor;
   * cheap enough to call from every heartbeat.
   */
  recheckAdmissionFloor: () => Promise<void>;
}

export interface WorkerJobResourcesDeps {
  env?: NodeJS.ProcessEnv;
  prime?: () => Promise<ResourceScopeDetection>;
  lock?: HeavyJobLock;
  memory?: Omit<WaitForMemoryOptions, "onWait" | "signal" | "timeoutMs">;
  now?: () => number;
}

async function warnIfFloorAboveAvailable(
  log: Logger,
  admitMinGiB: number,
  memory: WorkerJobResourcesDeps["memory"],
): Promise<void> {
  const available = await readMemAvailableGiB(memory);
  if (available === null || available >= admitMinGiB) return;
  log.warn(
    {
      admit_min_gib: Number(admitMinGiB.toFixed(1)),
      available_gib: Number(available.toFixed(1)),
      explicit: false,
      env_var: "PENUMBRA_JOB_ADMIT_MIN_GIB",
    },
    ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG,
  );
}

interface ClaimAdmissionTimeoutArgs {
  handoffId: string;
  availableGiB: number | null;
  admitMinGiB: number;
  waitedMs: number;
  explicit: boolean;
}

function warnClaimAdmissionTimeout(log: Logger, args: ClaimAdmissionTimeoutArgs): void {
  log.warn(
    {
      handoff_id: args.handoffId,
      available_gib: args.availableGiB === null ? null : Number(args.availableGiB.toFixed(1)),
      min_gib: Number(args.admitMinGiB.toFixed(1)),
      waited_s: Math.round(args.waitedMs / 1000),
      explicit: args.explicit,
      env_var: "PENUMBRA_JOB_ADMIT_MIN_GIB",
    },
    CLAIM_ADMISSION_TIMEOUT_MSG,
  );
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
    await warnIfFloorAboveAvailable(log, admitMinGiB, deps.memory);
  }
  const waitMs = jobEnv.admitWaitS * 1000;
  const lock = deps.lock ?? new HeavyJobLock({ path: jobEnv.heavyLockPath, log });
  if (!lock.crossProcess) {
    log.warn(
      {
        path: lock.path,
        remedy:
          'in-process only because crossProcessFallback is "none" and no flock(1) binary was found; install flock(1) (e.g. Homebrew flock) and restart the daemon, or set crossProcessFallback to "sqlite" to enable the SQLite fallback',
      },
      HEAVY_LOCK_IN_PROCESS_ONLY_MSG,
    );
  }
  const heavyStageGate = createHeavyJobGate({
    lock,
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
      warnClaimAdmissionTimeout(log, {
        handoffId: handoff.handoff_id,
        availableGiB: admission.availableGiB,
        admitMinGiB,
        waitedMs: admission.waitedMs,
        explicit: jobEnv.admitMinGiB !== undefined,
      });
    }
    return admission.admitted;
  };
  const now = deps.now ?? ((): number => Date.now());
  let lastFloorCheckedAtMs = now();
  const recheckAdmissionFloor = async (): Promise<void> => {
    if (jobEnv.admitMinGiB !== undefined || admitMinGiB <= 0) return;
    const nowMs = now();
    if (nowMs - lastFloorCheckedAtMs < ADMISSION_FLOOR_RECHECK_INTERVAL_MS) return;
    // Stamped before the await so overlapping heartbeat calls cannot warn twice.
    lastFloorCheckedAtMs = nowMs;
    await warnIfFloorAboveAvailable(log, admitMinGiB, deps.memory);
  };
  return { scope, heavyStageGate, admitClaim, recheckAdmissionFloor };
}
