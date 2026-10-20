import { z } from "zod";

import { type GhRunner, runGh } from "./gh-runner.js";

export type OpenPrChecks = "success" | "failure" | "pending" | "none";

export type OpenPr = {
  number: number;
  title: string;
  head_ref: string;
  author: string | null;
  created_at: string;
  checks: OpenPrChecks;
  foreign_author: boolean | null;
};

export type OpenPrsResult = { prs: OpenPr[]; reason: null } | { prs: null; reason: string };

export type CollectOpenPrsInput = {
  cwd: string;
  run?: GhRunner;
  timeoutMs?: number;
};

const GH_ARGS = [
  "pr",
  "list",
  "--state",
  "open",
  "--json",
  "number,title,headRefName,author,createdAt,statusCheckRollup",
];
const LOGIN_ARGS = ["api", "user", "--jq", ".login"];
const GH_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UNPARSEABLE = "gh pr list returned unparseable output";
const FAILED_OUTCOMES = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

// CheckRun entries carry status/conclusion and StatusContext entries carry state; gh may
// fill the other type's fields with "", so read empty strings as absent.
const ghCheckField = z
  .string()
  .nullish()
  .transform((value) => (value === "" || value === null ? undefined : value));
const GhCheckSchema = z.object({
  status: ghCheckField,
  conclusion: ghCheckField,
  state: ghCheckField,
});
type GhCheck = z.infer<typeof GhCheckSchema>;

const GhPrListSchema = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    headRefName: z.string(),
    author: z.object({ login: z.string() }).nullable().optional(),
    createdAt: z.string(),
    statusCheckRollup: z.array(GhCheckSchema).nullable().optional(),
  }),
);

function checkState(check: GhCheck): OpenPrChecks {
  if (check.status !== undefined && check.status !== "COMPLETED") return "pending";
  const outcome = check.conclusion ?? check.state ?? "";
  if (FAILED_OUTCOMES.has(outcome)) return "failure";
  return PENDING_STATES.has(outcome) ? "pending" : "success";
}

function summarizeChecks(rollup: GhCheck[] | null | undefined): OpenPrChecks {
  if (!rollup || rollup.length === 0) return "none";
  const states = new Set(rollup.map(checkState));
  if (states.has("failure")) return "failure";
  return states.has("pending") ? "pending" : "success";
}

function isForeignAuthor(author: string | null, login: string | null): boolean | null {
  if (login === null) return null;
  return author?.toLowerCase() !== login.toLowerCase();
}

function parsePrList(stdout: string, login: string | null): OpenPrsResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { prs: null, reason: UNPARSEABLE };
  }
  const parsed = GhPrListSchema.safeParse(raw);
  if (!parsed.success) return { prs: null, reason: UNPARSEABLE };
  return {
    prs: parsed.data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      head_ref: pr.headRefName,
      author: pr.author?.login ?? null,
      created_at: pr.createdAt,
      checks: summarizeChecks(pr.statusCheckRollup),
      foreign_author: isForeignAuthor(pr.author?.login ?? null, login),
    })),
    reason: null,
  };
}

async function resolveGhLogin(input: CollectOpenPrsInput): Promise<string | null> {
  const out = await runGh({ ...input, args: LOGIN_ARGS });
  const login = out.stdout?.trim() ?? "";
  return GH_LOGIN_RE.test(login) ? login : null;
}

export async function collectOpenPrs(input: CollectOpenPrsInput): Promise<OpenPrsResult> {
  const [list, login] = await Promise.all([
    runGh({ ...input, args: GH_ARGS }),
    resolveGhLogin(input),
  ]);
  return list.stdout === null
    ? { prs: null, reason: list.reason }
    : parsePrList(list.stdout, login);
}
