import {
  agentEnforcesPermissionProfile,
  type PermissionProfile,
  type PermissionProfileSeatLike,
} from "@penumbra/core";

export class ProfileEnforcementError extends Error {
  constructor(
    readonly agentName: string,
    readonly profile: PermissionProfile,
  ) {
    super(`agent '${agentName}' cannot enforce permission_profile '${profile}'`);
    this.name = "ProfileEnforcementError";
  }
}

/**
 * Last-line worker check before a profiled dispatch spawns. The daemon claim
 * gate should have refused the claim already; this catches stale claims,
 * config reloads, and worker_id spoofing so a profiled handoff can never run
 * unconstrained on a seat that cannot enforce it.
 */
export function assertProfileDispatchSeat(opts: {
  agentName: string;
  permissionProfile: PermissionProfile | null | undefined;
  seat?: PermissionProfileSeatLike | null;
}): void {
  if (opts.permissionProfile === undefined || opts.permissionProfile === null) return;
  if (agentEnforcesPermissionProfile(opts.seat, opts.permissionProfile)) return;
  throw new ProfileEnforcementError(opts.agentName, opts.permissionProfile);
}
