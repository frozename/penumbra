export interface HandoffBranchNameInput {
  handoff_id: string;
  branch_name?: string | null;
}

export interface BuildHandoffBranchNameInput {
  handoff_id: string;
  task_name?: string | null;
  branch_type?: string | null;
  workload?: string | null;
  task_type?: string | null;
}

const BRANCH_TYPE_RE = /^[a-z][a-z0-9-]{0,19}$/;
const MAX_SLUG_LENGTH = 48;

const WORKLOAD_BRANCH_TYPES: Record<string, string> = {
  implement_small: "feat",
  implement_substantial: "feat",
  debug_diagnose: "fix",
  docs_mechanical: "docs",
  review_adversarial: "review",
  plan_refine: "plan",
  smoke_test: "chore",
  health_check: "chore",
};

export function resolveHandoffBranchName(handoff: HandoffBranchNameInput): string {
  return handoff.branch_name ?? `agent/${handoff.handoff_id}`;
}

export function slugifyBranchSegment(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (normalized.length <= MAX_SLUG_LENGTH) return normalized;

  const capped = normalized.slice(0, MAX_SLUG_LENGTH);
  const lastDash = capped.lastIndexOf("-");
  const cut = lastDash > 0 ? capped.slice(0, lastDash) : capped;
  return cut.replace(/^-|-$/g, "");
}

function validateBranchType(branchType: string): string {
  if (!BRANCH_TYPE_RE.test(branchType)) {
    throw new Error("branch_type must match /^[a-z][a-z0-9-]{0,19}$/ and be at most 20 characters");
  }
  if (branchType === "agent") {
    throw new Error("branch_type 'agent' is reserved for legacy handoff branches");
  }
  return branchType;
}

function branchTypeFor(input: BuildHandoffBranchNameInput): string {
  if (input.branch_type !== undefined && input.branch_type !== null) {
    return validateBranchType(input.branch_type);
  }
  const workload = input.workload ?? input.task_type ?? null;
  return workload !== null ? (WORKLOAD_BRANCH_TYPES[workload] ?? "task") : "task";
}

function handoffIdSlugFallback(handoffId: string): string {
  const hex = handoffId.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.slice(0, 8) || "handoff";
}

export function buildHandoffBranchName(input: BuildHandoffBranchNameInput): string {
  const type = branchTypeFor(input);
  const slug =
    slugifyBranchSegment(input.task_name ?? "") || handoffIdSlugFallback(input.handoff_id);
  return `${type}/${slug}`;
}
