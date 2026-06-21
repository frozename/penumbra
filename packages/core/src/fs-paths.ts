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

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessageOf(err: unknown): string {
  if (typeof err === "object" && err && "message" in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

async function resolveMissingLeaf(
  candidate: string,
  worktreeReal: string,
  userPath: string,
): Promise<never> {
  let real: string;
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
    if (errorCodeOf(err) === "ENOENT") {
      await resolveMissingLeaf(candidate, worktreeReal, userPath);
    }
    throw new FsPathError("io", `failed to resolve ${userPath}: ${errorMessageOf(err)}`);
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
