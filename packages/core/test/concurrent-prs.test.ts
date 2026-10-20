import { expect, test } from "bun:test";

import { findConcurrentPrs, referencedIssueNumbers } from "@src/concurrent-prs.js";
import type { GhRunner } from "@src/gh-runner.js";

type GhCall = { cmd: string; args: string[]; opts: { cwd: string; timeout: number } };

type SearchPr = {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  author: { login: string } | null;
  url: string;
};

function searchPr(number: number, title: string, body: string, headRefName: string): SearchPr {
  return {
    number,
    title,
    body,
    headRefName,
    author: { login: `author-${String(number)}` },
    url: `https://github.com/acme/repo/pull/${String(number)}`,
  };
}

function searchRunner(byIssue: Record<string, SearchPr[]>, calls: GhCall[] = []): GhRunner {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const query = args[args.indexOf("--search") + 1] ?? "";
    const issue = query.split(" ")[0] ?? "";
    return Promise.resolve({ stdout: JSON.stringify(byIssue[issue] ?? []), stderr: "" });
  };
}

function failingRunner(fields: Record<string, unknown>): GhRunner {
  return () => Promise.reject(Object.assign(new Error("gh failed"), fields));
}

function stdoutRunner(stdout: string): GhRunner {
  return () => Promise.resolve({ stdout, stderr: "" });
}

const throwingRunner: GhRunner = () => {
  throw new Error("spawn exploded");
};

const LANDING_BRANCH = "fix/issue-71_abcd1234";

test("referencedIssueNumbers reads Fixes, Refs and bare #N references in first-seen order", () => {
  expect(
    referencedIssueNumbers(
      "fix(core): stop the leak in #12\n\nSee #12 and #40.\n\nFixes #71\nRefs: #88",
    ),
  ).toEqual([71, 88, 12, 40]);
});

test("referencedIssueNumbers ignores cross-repo refs, anchors, entities and #0", () => {
  expect(
    referencedIssueNumbers("other/repo#5 a#6 ##7 &#8; #0 https://x/pull/3#issuecomment-9 (#10)"),
  ).toEqual([10]);
});

test("referencedIssueNumbers caps the list and keeps keyword refs ahead of bare mentions", () => {
  expect(referencedIssueNumbers("#1 #2 #3 #4 #5 #6\n\nCloses #99")).toEqual([99, 1, 2, 3, 4]);
});

test("findConcurrentPrs searches open PRs per referenced issue with a bounded timeout", async () => {
  const calls: GhCall[] = [];

  await findConcurrentPrs({
    cwd: "/repo",
    branch: LANDING_BRANCH,
    commitMessage: "feat(core): land it\n\nFixes #71\nRefs #72",
    run: searchRunner({}, calls),
    timeoutMs: 1234,
  });

  expect(calls).toEqual(
    [71, 72].map((issue) => ({
      cmd: "gh",
      args: [
        "pr",
        "list",
        "--state",
        "open",
        "--search",
        `${String(issue)} in:title,body`,
        "--json",
        "number,title,body,headRefName,author,url",
        "--limit",
        "20",
      ],
      opts: { cwd: "/repo", timeout: 1234 },
    })),
  );
});

test("findConcurrentPrs reports another open PR that references the same issue", async () => {
  const result = await findConcurrentPrs({
    cwd: "/repo",
    branch: LANDING_BRANCH,
    commitMessage: "feat(core): implement the thing\n\nFixes #71",
    run: searchRunner({
      "71": [
        searchPr(74, "Implement #71", "Closes #71", "feat/other-account"),
        searchPr(78, "Fix #71", "Fixes #71", LANDING_BRANCH),
      ],
    }),
  });

  expect(result).toEqual([
    {
      number: 74,
      title: "Implement #71",
      head_ref: "feat/other-account",
      author: "author-74",
      url: "https://github.com/acme/repo/pull/74",
      issue: 71,
    },
  ]);
});

test("findConcurrentPrs drops search hits that do not actually reference the issue", async () => {
  const result = await findConcurrentPrs({
    cwd: "/repo",
    branch: LANDING_BRANCH,
    commitMessage: "Fixes #71",
    run: searchRunner({
      "71": [
        searchPr(90, "Bump to v1.71", "71 files changed", "chore/bump"),
        searchPr(91, "Port", "Fixes other/repo#71", "feat/port"),
        { ...searchPr(92, "Ghost", "Part of #71", "feat/ghost"), author: null },
      ],
    }),
  });

  expect(result.map((pr) => [pr.number, pr.author])).toEqual([[92, null]]);
});

test("findConcurrentPrs does not run gh when the commit message references no issue", async () => {
  const calls: GhCall[] = [];

  const result = await findConcurrentPrs({
    cwd: "/repo",
    branch: LANDING_BRANCH,
    commitMessage: "chore: tidy",
    run: searchRunner({}, calls),
  });

  expect(result).toEqual([]);
  expect(calls).toEqual([]);
});

test("findConcurrentPrs fails open to no warning when gh is missing, fails, or prints garbage", async () => {
  const runs: GhRunner[] = [
    failingRunner({ code: "ENOENT" }),
    failingRunner({ code: 1, stderr: "no git remotes found\n" }),
    failingRunner({ killed: true, signal: "SIGTERM" }),
    stdoutRunner("not json"),
    stdoutRunner('[{"number":"74"}]'),
    throwingRunner,
  ];
  for (const run of runs) {
    const result = await findConcurrentPrs({
      cwd: "/repo",
      branch: LANDING_BRANCH,
      commitMessage: "Fixes #71",
      run,
    });

    expect(result).toEqual([]);
  }
});

test("findConcurrentPrs stops waiting at the timeout when gh never settles", async () => {
  const startedAt = Date.now();

  const result = await findConcurrentPrs({
    cwd: "/repo",
    branch: LANDING_BRANCH,
    commitMessage: "Fixes #71\nRefs #72",
    run: () => new Promise(() => undefined),
    timeoutMs: 20,
  });

  expect(result).toEqual([]);
  expect(Date.now() - startedAt).toBeLessThan(1000);
});

test("findConcurrentPrs keeps the hits of issues whose search succeeded", async () => {
  const ok = searchRunner({ "72": [searchPr(75, "Refs #72", "", "feat/seventy-two")] });
  const failing = failingRunner({ code: 1, stderr: "HTTP 502\n" });
  const run: GhRunner = (cmd, args, opts) =>
    (args.includes("71 in:title,body") ? failing : ok)(cmd, args, opts);

  const result = await findConcurrentPrs({
    cwd: "/repo",
    branch: LANDING_BRANCH,
    commitMessage: "Fixes #71\nFixes #72",
    run,
  });

  expect(result.map((pr) => [pr.number, pr.issue])).toEqual([[75, 72]]);
});
