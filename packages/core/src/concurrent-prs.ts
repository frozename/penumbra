import { z } from "zod";

import { type GhRunner, runGh } from "./gh-runner.js";

export type ConcurrentPr = {
  number: number;
  title: string;
  head_ref: string;
  author: string | null;
  url: string;
  issue: number;
};

export type FindConcurrentPrsInput = {
  cwd: string;
  branch: string;
  commitMessage: string;
  run?: GhRunner;
  timeoutMs?: number;
};

const MAX_ISSUES = 5;
const SEARCH_LIMIT = "20";
const SEARCH_FIELDS = "number,title,body,headRefName,author,url";
const KEYWORD_REF_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|part of):?\s+#(\d+)\b/gi;
// Lookbehind skips owner/repo#N (another repo's issue), word#N, ##N and &#N; HTML entities.
const BARE_REF_RE = /(?<![\w/#&])#(\d+)\b/g;

const GhSearchSchema = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullish(),
    headRefName: z.string(),
    author: z.object({ login: z.string() }).nullish(),
    url: z.string(),
  }),
);

function matchNumbers(text: string, re: RegExp): number[] {
  return [...text.matchAll(re)].map((match) => Number(match[1])).filter((n) => n > 0);
}

export function referencedIssueNumbers(text: string): number[] {
  const ordered = [...matchNumbers(text, KEYWORD_REF_RE), ...matchNumbers(text, BARE_REF_RE)];
  return [...new Set(ordered)].slice(0, MAX_ISSUES);
}

async function searchIssue(input: FindConcurrentPrsInput, issue: number): Promise<ConcurrentPr[]> {
  const out = await runGh({
    cwd: input.cwd,
    run: input.run,
    timeoutMs: input.timeoutMs,
    args: [
      "pr",
      "list",
      "--state",
      "open",
      "--search",
      `${String(issue)} in:title,body`,
      "--json",
      SEARCH_FIELDS,
      "--limit",
      SEARCH_LIMIT,
    ],
  });
  if (out.stdout === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch {
    return [];
  }
  const parsed = GhSearchSchema.safeParse(raw);
  if (!parsed.success) return [];
  // Search matches the bare number anywhere in the text, so keep only real #N references.
  return parsed.data
    .filter((pr) => pr.headRefName !== input.branch)
    .filter((pr) => matchNumbers(`${pr.title}\n${pr.body ?? ""}`, BARE_REF_RE).includes(issue))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      head_ref: pr.headRefName,
      author: pr.author?.login ?? null,
      url: pr.url,
      issue,
    }));
}

export async function findConcurrentPrs(input: FindConcurrentPrsInput): Promise<ConcurrentPr[]> {
  const issues = referencedIssueNumbers(input.commitMessage);
  const hits = await Promise.all(issues.map((issue) => searchIssue(input, issue)));
  return hits.flat();
}
