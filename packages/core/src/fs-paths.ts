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

const OUTSIDE_WORKTREE_MESSAGE = "path is outside the worktree";

function isInside(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function outsideWorktreeError(): FsPathError {
  return new FsPathError("outside_worktree", OUTSIDE_WORKTREE_MESSAGE);
}

async function resolveMissingLeaf(
  candidate: string,
  worktreeAbs: string,
  worktreeReal: string,
  userPath: string,
): Promise<never> {
  let parentReal: string | null = null;
  try {
    parentReal = await fs.realpath(path.dirname(candidate));
  } catch {
    parentReal = null;
  }

  if (parentReal !== null) {
    const real = path.join(parentReal, path.basename(candidate));
    if (!isInside(worktreeReal, real)) {
      throw outsideWorktreeError();
    }
    throw new FsPathError("not_found", `file not found: ${userPath}`);
  }

  if (!isInside(worktreeAbs, candidate)) {
    throw outsideWorktreeError();
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
      await resolveMissingLeaf(candidate, worktreeAbs, worktreeReal, userPath);
    }
    throw new FsPathError("io", `failed to resolve ${userPath}: ${errorMessageOf(err)}`);
  }

  if (!isInside(worktreeReal, real)) {
    throw outsideWorktreeError();
  }

  return real;
}
