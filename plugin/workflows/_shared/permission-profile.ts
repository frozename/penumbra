import { PERMISSION_PROFILE_REVIEW_READONLY, type PermissionProfile } from "@penumbra/core";

export { PERMISSION_PROFILE_REVIEW_READONLY };
export type { PermissionProfile };

export const READ_ONLY_REVIEW_INSTRUCTION =
  "You are running under a read-only review profile: do not modify files, run tests, execute builds, or otherwise mutate the repository. To inspect earlier revisions use read-only commands such as `git show <ref>:<path>`.";

/**
 * A dispatch that requested a permission profile must carry the echoed profile
 * back. A missing or mismatched echo means the chain was created without the
 * profile (stale ctx / stale daemon) — fail closed instead of letting a review
 * persona run unguarded.
 */
export function requireDispatchProfileEcho(
  dispatch: { permission_profile?: PermissionProfile | null },
  profile: PermissionProfile,
): void {
  if (dispatch.permission_profile !== profile) {
    throw new Error(
      `permission_profile_echo_mismatch: chain_start echoed ${JSON.stringify(dispatch.permission_profile)} for a ${profile} dispatch`,
    );
  }
}
