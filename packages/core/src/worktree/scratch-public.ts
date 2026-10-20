// Curated public surface of the scratch worktree helpers. The package barrel
// re-exports this module in one line, so it stays under max-lines without
// publishing the owner-marker internals of ./scratch.ts.
export {
  resolveCommonGitDir,
  resolveWorktreeGitDir,
  type ScratchCwdValidation,
  type ScratchDaemonIdentity,
  validateScratchCwd,
} from "./scratch.js";
