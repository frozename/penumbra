import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

async function gitBranchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFile("git", [
      "-C",
      repoRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function availableBranchNameBestEffort(
  repoRoot: string | undefined,
  requestedName: string,
): Promise<string> {
  if (repoRoot === undefined) return requestedName;
  try {
    await execFile("git", ["-C", repoRoot, "rev-parse", "--git-dir"]);
    if (!(await gitBranchExists(repoRoot, requestedName))) return requestedName;
    for (let suffix = 2; suffix <= 99; suffix += 1) {
      const candidate = `${requestedName}-${String(suffix)}`;
      if (!(await gitBranchExists(repoRoot, candidate))) return candidate;
    }
  } catch {
    return requestedName;
  }
  throw new Error(`branch_name_collision_exhausted: ${requestedName}`);
}
