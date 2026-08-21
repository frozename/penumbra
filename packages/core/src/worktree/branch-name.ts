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
  message?: string | null;
}

const BRANCH_TYPE_RE = /^[a-z][a-z0-9-]{0,19}$/;
const MAX_SLUG_LENGTH = 48;
const MESSAGE_DERIVE_WORD_COUNT = 6;
const LEADING_BRACKET_TAG_RE = /^\[[^\]\r\n]*\]\s*/;
const KEY_VALUE_TOKEN_RE = /^[\w.-]+=\S+$/;

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

function shortHandoffId(handoffId: string): string {
  const hex = handoffId.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.slice(0, 8) || "handoff";
}

/**
 * Strips a leading `[tag]` plus any immediately-following `key=value` tokens,
 * e.g. the silent-failure-retry stamp `[silent-failure-retry] retry_of=x prior_agent=y`.
 * Stripping only the bracket would leave that machine metadata as the "name" —
 * consuming the key=value run too lets derivation fall through to the real
 * message below it. Tokens are walked one at a time (not one big regex) to
 * keep the match bounded and avoid backtracking blowups on adversarial input.
 */
function stripLeadingTag(line: string): string {
  const bracketMatch = LEADING_BRACKET_TAG_RE.exec(line);
  if (!bracketMatch) return line;
  const words = line.slice(bracketMatch[0].length).split(/\s+/);
  let i = 0;
  while (i < words.length && KEY_VALUE_TOKEN_RE.test(words[i] ?? "")) {
    i += 1;
  }
  return words.slice(i).join(" ");
}

/**
 * Turns a raw dispatch message into a branch-name slug, for dispatches that
 * omit task_name. Uses the first non-empty line, stripping a leading stamped
 * `[tag] key=value ...` prefix so a retry/system stamp never becomes the name.
 * Returns "" when nothing usable is found (caller falls back to a literal).
 */
export function deriveBranchNameFromMessage(message: string | null | undefined): string {
  if (typeof message !== "string") return "";
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const stripped = stripLeadingTag(line).trim();
    if (!stripped) continue;
    const words = stripped.split(/\s+/).slice(0, MESSAGE_DERIVE_WORD_COUNT).join(" ");
    const slug = slugifyBranchSegment(words);
    if (slug) return slug;
  }
  return "";
}

/**
 * `<type>/<name>_<shortid>` — the underscore separator is deliberate: the name
 * part uses `-`, so `_` unambiguously marks the id seam and lets a retry parse
 * a prior branch name back into its task_name (see silent-failure-retry.ts).
 */
export function buildHandoffBranchName(input: BuildHandoffBranchNameInput): string {
  const type = branchTypeFor(input);
  const nameSlug =
    slugifyBranchSegment(input.task_name ?? "") ||
    deriveBranchNameFromMessage(input.message) ||
    "handoff";
  return `${type}/${nameSlug}_${shortHandoffId(input.handoff_id)}`;
}
