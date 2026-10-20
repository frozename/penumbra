import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type BranchProbeRunner = (args: readonly string[]) => Promise<unknown>;

const defaultRunGit: BranchProbeRunner = async (args) => await execFile("git", [...args]);

async function gitBranchExists(
  runGit: BranchProbeRunner,
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  try {
    await runGit(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

export async function availableBranchNameBestEffort(
  repoRoot: string | undefined,
  requestedName: string,
  runGit: BranchProbeRunner = defaultRunGit,
): Promise<string> {
  if (repoRoot === undefined) return requestedName;
  if (!(await gitBranchExists(runGit, repoRoot, requestedName))) return requestedName;
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${requestedName}-${String(suffix)}`;
    if (!(await gitBranchExists(runGit, repoRoot, candidate))) return candidate;
  }
  throw new Error(`branch_name_collision_exhausted: ${requestedName}`);
}
