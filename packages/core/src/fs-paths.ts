import * as fs from "node:fs/promises";
import * as path from "node:path";

export class FsPathError extends Error {
  constructor(
    public readonly code: "outside_worktree" | "not_found" | "io",
    message: string,
  ) {
    super(message);
    this.name = "FsPathError";
  }
}

export async function resolveInsideWorktree(userPath: string, worktree: string): Promise<string> {
  const worktreeAbs = path.resolve(worktree);
  const worktreeReal = await fs.realpath(worktreeAbs);
  const candidate = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(worktreeAbs, userPath);

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err: unknown) {
    const errorCode = typeof err === "object" && err && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (errorCode === "ENOENT") {
      // Non-existent leaf: realpath the parent dir so we still get canonical
      // platform path translation (e.g. macOS /var -> /private/var), then
      // re-attach the basename. This lets us detect outside-worktree escapes
      // even when the file doesn't yet exist; if even the parent is missing,
      // surface as not_found.
      try {
        const parentReal = await fs.realpath(path.dirname(candidate));
        real = path.join(parentReal, path.basename(candidate));
      } catch {
        throw new FsPathError("not_found", `file not found: ${userPath}`);
      }
      const relForMissing = path.relative(worktreeReal, real);
      if (relForMissing.startsWith("..") || path.isAbsolute(relForMissing)) {
        throw new FsPathError(
          "outside_worktree",
          `path "${userPath}" resolves outside worktree (real path: ${real})`,
        );
      }
      throw new FsPathError("not_found", `file not found: ${userPath}`);
    }
    const errorMessage =
      typeof err === "object" && err && "message" in err ? String((err as { message?: unknown }).message) : String(err);
    throw new FsPathError("io", `failed to resolve ${userPath}: ${errorMessage}`);
  }

  const rel = path.relative(worktreeReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FsPathError(
      "outside_worktree",
      `path "${userPath}" resolves outside worktree (real path: ${real})`,
    );
  }

  return real;
}
