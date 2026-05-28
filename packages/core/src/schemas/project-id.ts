import { z } from "zod";

/**
 * Safe project-id schema.
 *
 * Permits the full output range of resolveProjectId():
 *   git kind:      "<16-hex>:<posix-relpath>"  e.g. "abcdef01234567:.  or  "abc:packages/x"
 *   marker kind:   UUID-like string from .penumbra-project file
 *   declared kind: arbitrary short identifier supplied by the user
 *
 * Explicitly disallows characters and sequences that could cause path traversal
 * when interpolated into fs.join() calls in ContextFileWriter:
 *   - NUL bytes
 *   - backslash (Windows path separator)
 *   - leading or trailing whitespace
 *   - leading slash (absolute path)
 *   - ".." path component (parent traversal)
 */
const SAFE_PROJECT_ID_RE = /^[A-Za-z0-9_.:\-/]{1,200}$/;

function isTraversalFree(s: string): boolean {
  // Reject any segment that is ".." when the string is split on "/"
  return !s.split("/").some((seg) => seg === "..");
}

export const SafeProjectIdSchema = z
  .string()
  .regex(SAFE_PROJECT_ID_RE, "project_id contains invalid characters")
  .refine((s) => !s.startsWith("/"), "project_id must not be an absolute path")
  .refine(isTraversalFree, 'project_id must not contain ".." path components')
  .refine((s) => s !== "__null__", "project_id cannot be __null__");

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
