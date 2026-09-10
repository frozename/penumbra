import { type SafeProjectId, SafeProjectIdSchema } from "@penumbra/api-contract";

export { type SafeProjectId, SafeProjectIdSchema };

const SAFE_PROJECT_ID_RE = /^[A-Za-z0-9_.:\-/]{1,200}$/;

function isTraversalFree(s: string): boolean {
  return !s.split("/").some((seg) => seg === "..");
}

/**
 * Defensive runtime assertion used inside ContextFileWriter.rewrite().
 * Throws a clear TypeError rather than silently writing to an attacker-controlled path.
 * Export so other fs-path consumers can reuse it.
 */
export function assertSafeProjectId(projectId: string): void {
  if (!SAFE_PROJECT_ID_RE.test(projectId)) {
    throw new TypeError(`Unsafe project_id rejected: ${JSON.stringify(projectId)}`);
  }
  if (projectId.startsWith("/")) {
    throw new TypeError(`Unsafe project_id rejected (absolute path): ${JSON.stringify(projectId)}`);
  }
  if (!isTraversalFree(projectId)) {
    throw new TypeError(
      `Unsafe project_id rejected (path traversal): ${JSON.stringify(projectId)}`,
    );
  }
}
