import type { WorktreeCommandRunner } from "./manager.js";

interface CommandError {
  code?: number | string | null;
  stderr?: unknown;
}

function extractExitCode(err: unknown): number | string | null | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as CommandError).code;
}

function extractStderr(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const raw = (err as CommandError).stderr;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString();
  return "";
}

// Shared land-status probes used by the worktree teardown branch-delete guard
// and the PR orphan sweeper. Both checks are conservative — any unexpected exit
// code rethrows so the caller can decide whether to defer (fail-closed) or
// surface the error.

export async function isAncestorOf(
  runner: WorktreeCommandRunner,
  repoDir: string,
  candidateRef: string,
  baseRef: string,
): Promise<boolean> {
  try {
    await runner("git", ["merge-base", "--is-ancestor", candidateRef, baseRef], { cwd: repoDir });
    return true;
  } catch (err) {
    const code = extractExitCode(err);
    if (code === 1) return false;
    throw new Error(
      `git merge-base --is-ancestor ${candidateRef} ${baseRef} failed (${String(code)}): ${extractStderr(err).slice(0, 500)}`,
    );
  }
}

export async function isThreeDotDiffEmpty(
  runner: WorktreeCommandRunner,
  repoDir: string,
  candidateRef: string,
  baseRef: string,
): Promise<boolean> {
  const { stdout } = await runner("git", ["diff", "--stat", `${baseRef}...${candidateRef}`], {
    cwd: repoDir,
  });
  return stdout.trim().length === 0;
}
