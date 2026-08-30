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

// Shared land-status probes used by branch cleanup guards. The primitive checks
// stay conservative: unexpected exits rethrow or return "error" so callers can
// preserve branches fail-closed.
export type BranchLandStatus = "landed" | "unlanded" | "error";

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

export async function classifyBranchByContent(
  runner: WorktreeCommandRunner,
  repoDir: string,
  baseRef: string,
  candidateRef: string,
): Promise<BranchLandStatus> {
  // Squash lands create a new commit, so the branch tip is not an ancestor of
  // main even when its tree is already present. merge-tree lets us compare the
  // in-memory merge result without touching the working tree.
  let baseTree: string;
  try {
    const { stdout } = await runner("git", ["rev-parse", `${baseRef}^{tree}`], { cwd: repoDir });
    baseTree = stdout.trim();
  } catch {
    return "error";
  }

  try {
    const { stdout } = await runner("git", ["merge-tree", "--write-tree", baseRef, candidateRef], {
      cwd: repoDir,
    });
    return stdout.trim() === baseTree ? "landed" : "unlanded";
  } catch (err) {
    const code = extractExitCode(err);
    if (code === 1) return "unlanded";
    return "error";
  }
}

export async function classifyBranchLandStatus(
  runner: WorktreeCommandRunner,
  repoDir: string,
  candidateRef: string,
  baseRef: string,
): Promise<BranchLandStatus> {
  try {
    if (await isAncestorOf(runner, repoDir, candidateRef, baseRef)) {
      return "landed";
    }
    if (await isThreeDotDiffEmpty(runner, repoDir, candidateRef, baseRef)) {
      return "landed";
    }
    return await classifyBranchByContent(runner, repoDir, baseRef, candidateRef);
  } catch {
    return "error";
  }
}
