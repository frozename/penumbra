import { type ConcurrentPr, findConcurrentPrs, type GhRunner, type Logger } from "@penumbra/core";

export type FindLandConcurrentPrs = (input: {
  branch: string;
  commitMessage: string;
}) => Promise<ConcurrentPr[]>;

export interface LandConcurrentPrsDeps {
  findConcurrentPrs?: FindLandConcurrentPrs;
}

export interface LandConcurrentPrsWarning {
  concurrent_prs?: ConcurrentPr[];
}

export function landConcurrentPrsFinder(opts: {
  cwd: string;
  run?: GhRunner;
  timeoutMs?: number;
}): FindLandConcurrentPrs {
  return (input) => findConcurrentPrs({ ...opts, ...input });
}

// Warn-only: nothing here may fail or refuse the land, so finder errors read as no warning.
export async function checkLandConcurrentPrs(input: {
  deps: LandConcurrentPrsDeps;
  log: Logger;
  handoff_id: string;
  branch: string;
  commitMessage: string;
}): Promise<LandConcurrentPrsWarning> {
  const { deps, log, handoff_id, branch, commitMessage } = input;
  if (!deps.findConcurrentPrs) return {};
  let concurrent_prs: ConcurrentPr[];
  try {
    concurrent_prs = await deps.findConcurrentPrs({ branch, commitMessage });
  } catch {
    return {};
  }
  if (concurrent_prs.length === 0) return {};
  log.warn(
    { handoff_id, branch, concurrent_prs },
    "dispatch-land: other open PRs reference the same issue as this land",
  );
  return { concurrent_prs };
}
