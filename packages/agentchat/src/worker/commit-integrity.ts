import {
  type CommitIntegrityEvidence,
  DISPATCH_BASE_CONFIG_KEY,
  isAncestorOf,
  type WorktreeCommandRunner,
} from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MISMATCHED_COMMITS_CAP = 50;

const defaultRunner: WorktreeCommandRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, encoding: "utf8" });

export async function probeCommitIntegrity(
  wtPath: string,
  runner: WorktreeCommandRunner = defaultRunner,
): Promise<CommitIntegrityEvidence | null> {
  try {
    const opts = { cwd: wtPath };
    const baseSha = (
      await runner("git", ["config", "--get", DISPATCH_BASE_CONFIG_KEY], opts)
    ).stdout.trim();
    const headSha = (await runner("git", ["rev-parse", "HEAD"], opts)).stdout.trim();
    if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) return null;

    const name = (await runner("git", ["config", "user.name"], opts)).stdout.trim();
    const email = (await runner("git", ["config", "user.email"], opts)).stdout.trim();

    const baseIsAncestor = await isAncestorOf(runner, wtPath, baseSha, headSha);

    const log = (
      await runner(
        "git",
        [
          "log",
          "--first-parent",
          "--format=%H%x00%an%x00%ae%x00%cn%x00%ce",
          `${baseSha}..${headSha}`,
        ],
        opts,
      )
    ).stdout;

    const mismatchedCommits: string[] = [];
    for (const line of log.split("\n")) {
      const [sha = "", authorName = "", authorEmail = "", committerName = "", committerEmail = ""] =
        line.split("\0");
      if (!SHA_RE.test(sha)) continue;
      if (
        authorName !== name ||
        authorEmail !== email ||
        committerName !== name ||
        committerEmail !== email
      ) {
        mismatchedCommits.push(sha);
      }
    }

    return {
      base_sha: baseSha,
      head_sha: headSha,
      base_is_ancestor: baseIsAncestor,
      identity: { name, email },
      mismatched_commits: mismatchedCommits.slice(0, MISMATCHED_COMMITS_CAP),
    };
  } catch {
    return null;
  }
}
