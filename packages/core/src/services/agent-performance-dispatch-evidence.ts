// #451: dispatch-side evidence for agent_performance. NULL means unknown,
// never false. This module writes no reserved metadata key and no head-scoped
// column.
import type { AgentPerformanceRow } from "../schemas/agent-performance.js";

export type ArtifactSource = "model_commit" | "none" | "recovery_autocommit";
export type DispatchEvidence = {
  columns: Pick<AgentPerformanceRow, "artifact_present" | "empty_response" | "worktree_changed">;
  extras: { artifact_source?: ArtifactSource };
};
export type DispatchResponseFacts = {
  attested: boolean;
  chainResponses: number;
  nonEmpty: boolean;
};

function flag(value: boolean | null): "n" | "y" | null {
  if (value === null) {
    return null;
  }
  return value ? "y" : "n";
}

function resolveWorktreeChanged(
  hint: boolean | null | undefined,
  meta: Record<string, unknown> | null,
): boolean | null {
  if (typeof hint === "boolean") {
    return hint;
  }
  if (meta !== null && typeof meta.worktree_changed === "boolean") {
    return meta.worktree_changed;
  }
  return null;
}

// The recovery autocommit (#379) runs only when the model left the tree dirty and uncommitted, so it wins.
function resolveArtifactSource(
  meta: Record<string, unknown> | null,
  worktreeChanged: boolean | null,
): ArtifactSource | null {
  if (meta?.autocommitted === true) {
    return "recovery_autocommit";
  }
  if (meta?.committed === true) {
    return "model_commit";
  }
  if (meta?.committed === false || worktreeChanged === false) {
    return "none";
  }
  return null;
}

export function dispatchEvidence(
  worktreeChangedHint: boolean | null | undefined,
  dispatchEndMeta: Record<string, unknown> | null,
  response: DispatchResponseFacts,
): DispatchEvidence {
  const worktreeChanged = resolveWorktreeChanged(worktreeChangedHint, dispatchEndMeta);
  const source = resolveArtifactSource(dispatchEndMeta, worktreeChanged);
  const responseKnown = response.attested || response.chainResponses > 0;
  return {
    columns: {
      worktree_changed: flag(worktreeChanged),
      artifact_present: source === null ? null : flag(source !== "none"),
      empty_response: responseKnown ? flag(!response.nonEmpty) : null,
    },
    extras: source === null ? {} : { artifact_source: source },
  };
}

// The reconciler refresh: dispatch.end facts only; no hint and no response read.
export function dispatchEndEvidence(
  dispatchEndMeta: Record<string, unknown> | null,
): DispatchEvidence {
  return dispatchEvidence(undefined, dispatchEndMeta, {
    attested: false,
    chainResponses: 0,
    nonEmpty: false,
  });
}
