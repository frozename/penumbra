import type { PermissionProfile, Services } from "@penumbra/core";

import type { ExtraWorkerConfig } from "../workers/config.js";

import { json } from "./_helpers.js";

export type WorkerAuthzMap = Map<
  string,
  { project_id?: string; isolation: ExtraWorkerConfig["isolation"] }
>;

type WorkerGateServices = Services & { workerAuthz?: WorkerAuthzMap };

interface WorkerTokenMetadataRow {
  worker_id: string;
  metadata_json: string | null;
}

export function workerHeartbeatStaleMs(): number {
  const configured = Number(process.env.PENUMBRA_WORKER_HEARTBEAT_STALE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 90_000;
}

export function workerCanClaimProject(
  authz: { project_id?: string; isolation: ExtraWorkerConfig["isolation"] } | undefined,
  project_id: string | null,
): boolean {
  return !(
    authz?.isolation === "hard" &&
    authz.project_id !== undefined &&
    project_id !== authz.project_id
  );
}

export function workerTokenMetadataDeclaresProfile(
  metadata_json: string | null,
  profile: PermissionProfile,
): boolean {
  if (!metadata_json) return false;
  try {
    const metadata = JSON.parse(metadata_json) as Record<string, unknown>;
    const list = metadata.enforces_permission_profiles;
    return Array.isArray(list) && list.includes(profile);
  } catch {
    return false;
  }
}

export function workerTokenMetadataDeclaresScratch(metadata_json: string | null): boolean {
  if (!metadata_json) return false;
  try {
    const metadata = JSON.parse(metadata_json) as Record<string, unknown>;
    return metadata.supports_scratch_worktrees === true;
  } catch {
    return false;
  }
}

// A profiled dispatch must never be admitted when zero live workers could
// claim it under the claim gate — the handoff would sit in `approved`
// forever (fail-open starvation) instead of failing at creation.
export function countFreshProfileEnforcingWorkers(
  services: WorkerGateServices,
  profile: PermissionProfile,
  project_id: string | null,
): number {
  const cutoff = Date.now() - workerHeartbeatStaleMs();
  const rows = services.db
    .query<WorkerTokenMetadataRow, [number]>(
      `SELECT worker_id, metadata_json
         FROM worker_tokens
        WHERE revoked_at IS NULL
          AND last_seen_at >= ?
        ORDER BY last_seen_at DESC`,
    )
    .all(cutoff);
  let n = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.worker_id)) continue;
    seen.add(row.worker_id);
    if (!workerCanClaimProject(services.workerAuthz?.get(row.worker_id), project_id)) continue;
    if (!workerTokenMetadataDeclaresProfile(row.metadata_json, profile)) continue;
    n++;
  }
  return n;
}

// A profiled dispatch admitted while zero live workers declare enforcement
// would sit in `approved` forever — every claim fails the claim gate. Fail
// closed at creation instead: 503 (a capable worker may join later), same
// machine-legible code as the other enforcement rejections.
export function profiledLiveWorkerGateResponse(
  services: WorkerGateServices,
  profile: PermissionProfile,
  project_id: string | null,
): Response | null {
  if (countFreshProfileEnforcingWorkers(services, profile, project_id) > 0) return null;
  services.log.warn(
    {
      event: "dispatch.permission_profile_no_enforcing_worker",
      permission_profile: profile,
      project_id,
    },
    "profiled dispatch rejected: no live worker declares enforcement of the profile",
  );
  return json(
    {
      error: {
        code: "permission_profile_unenforceable",
        message: `no live worker declares enforcement of permission_profile '${profile}'`,
        permission_profile: profile,
      },
    },
    503,
  );
}

// Scratch-routed dispatches need the same no-capable-worker fail-closed
// check as permission profiles: admitted while zero live workers can resolve
// a scratch cwd, the handoff would idle in `approved` forever.
export function countFreshScratchCapableWorkers(
  services: WorkerGateServices,
  project_id: string | null,
): number {
  const cutoff = Date.now() - workerHeartbeatStaleMs();
  const rows = services.db
    .query<WorkerTokenMetadataRow, [number]>(
      `SELECT worker_id, metadata_json
         FROM worker_tokens
        WHERE revoked_at IS NULL
          AND last_seen_at >= ?
        ORDER BY last_seen_at DESC`,
    )
    .all(cutoff);
  let n = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.worker_id)) continue;
    seen.add(row.worker_id);
    if (!workerCanClaimProject(services.workerAuthz?.get(row.worker_id), project_id)) continue;
    if (!workerTokenMetadataDeclaresScratch(row.metadata_json)) continue;
    n++;
  }
  return n;
}

export function scratchLiveWorkerGateResponse(
  services: WorkerGateServices,
  project_id: string | null,
): Response | null {
  if (countFreshScratchCapableWorkers(services, project_id) > 0) return null;
  services.log.warn(
    { event: "dispatch.scratch_no_capable_worker", project_id },
    "scratch dispatch rejected: no live worker declares scratch-worktree support",
  );
  return json(
    {
      error: {
        code: "scratch_capable_worker_unavailable",
        message: "no live worker declares scratch-worktree support",
      },
    },
    503,
  );
}

export type { WorkerGateServices };
