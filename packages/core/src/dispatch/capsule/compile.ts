import type { BudgetLimits, DroppedItem, TokenCounter } from "./budget.js";

import { type AdvisoryKind, SHED_ORDER } from "./render.js";
import {
  type AdvisoryItem,
  type ArtifactHandle,
  type Capsule,
  type CapsuleRefusal,
  type CheckRecipe,
  type EssentialConstraint,
  type LastError,
  refusal,
  type Tool,
} from "./schema.js";

const ADVISORY_SHED_KIND_ORDER: readonly AdvisoryKind[] = SHED_ORDER;

export interface GitPort {
  readonly headSha: () => Promise<string | null>;
  readonly resolveSha: (ref: string) => Promise<string | null>;
  readonly isAncestor: (ancestor: string, descendant: string) => Promise<boolean | null>;
}

export const PRIVILEGE_KEYS = ["write_fence", "tools", "grants"] as const;

export interface CompileInput {
  readonly objective: string;
  readonly acceptance_state: string;
  readonly base_sha: string;
  readonly dependencies: readonly string[];
  readonly write_fence: readonly string[];
  readonly essential_constraints: readonly EssentialConstraint[];
  readonly check_recipes: readonly CheckRecipe[];
  readonly tool_ids: readonly string[];
  readonly registry: readonly Tool[];
  readonly artifact_handles: readonly ArtifactHandle[];
  readonly advisory: {
    readonly memory: readonly AdvisoryItem[];
    readonly repo_map?: AdvisoryItem;
    readonly log_excerpts: readonly AdvisoryItem[];
  };
  readonly last_error?: LastError;
}

export interface CompileOptions {
  readonly git: GitPort;
  readonly budget: BudgetLimits;
  readonly counter?: TokenCounter;
}

export interface CompileSuccess {
  ok: true;
  capsule: Capsule;
  dropped: DroppedItem[];
}

export type CompileResult = CompileSuccess | CapsuleRefusal;

export async function compileCapsule(
  input: CompileInput,
  options: CompileOptions,
): Promise<CompileResult> {
  void input;
  void options;
  void ADVISORY_SHED_KIND_ORDER;
  return await Promise.resolve(refusal("ref_out_of_scope", "not implemented"));
}
