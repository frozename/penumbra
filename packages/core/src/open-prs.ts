import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

export type OpenPrChecks = "success" | "failure" | "pending" | "none";

export type OpenPr = {
  number: number;
  title: string;
  head_ref: string;
  author: string | null;
  created_at: string;
  checks: OpenPrChecks;
};

export type OpenPrsResult = { prs: OpenPr[]; reason: null } | { prs: null; reason: string };

export type OpenPrsRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type CollectOpenPrsInput = {
  cwd: string;
  run?: OpenPrsRunner;
  timeoutMs?: number;
};

const execFile = promisify(execFileCb);
const DEFAULT_TIMEOUT_MS = 5_000;
const GH_ARGS = [
  "pr",
  "list",
  "--state",
  "open",
  "--json",
  "number,title,headRefName,author,createdAt,statusCheckRollup",
];
const NOT_GITHUB_RE = /not a git repository|no git remotes found|none of the git remotes/i;
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

const defaultRun: OpenPrsRunner = (cmd, args, opts) => execFile(cmd, args, opts);

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

function parsePrList(stdout: string): OpenPrsResult {
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
    })),
    reason: null,
  };
}

function timedOut(timeoutMs: number): string {
  return `gh pr list timed out after ${String(timeoutMs)}ms`;
}

function describeFailure(err: unknown, timeoutMs: number): string {
  const fields = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  if (fields.code === "ENOENT") return "gh not installed";
  if (fields.killed === true) return timedOut(timeoutMs);
  const stderr = typeof fields.stderr === "string" ? fields.stderr : "";
  if (NOT_GITHUB_RE.test(stderr)) return "not a GitHub repository";
  const firstLine = stderr.split("\n").find((line) => line.trim().length > 0);
  const detail = firstLine ?? (err instanceof Error ? err.message : String(err));
  return `gh pr list failed: ${detail.trim().slice(0, 200)}`;
}

export async function collectOpenPrs(input: CollectOpenPrsInput): Promise<OpenPrsResult> {
  const run = input.run ?? defaultRun;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The runner gets the timeout too so a real gh child is killed; the race bounds runners that ignore it.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });
  try {
    const out = await Promise.race([
      run("gh", GH_ARGS, { cwd: input.cwd, timeout: timeoutMs }),
      deadline,
    ]);
    return out === null ? { prs: null, reason: timedOut(timeoutMs) } : parsePrList(out.stdout);
  } catch (err) {
    return { prs: null, reason: describeFailure(err, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}
