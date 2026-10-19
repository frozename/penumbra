import { expect, test } from "bun:test";

import { collectOpenPrs, type OpenPrsRunner } from "@src/open-prs.js";

function failingRunner(fields: Record<string, unknown>): OpenPrsRunner {
  return () => Promise.reject(Object.assign(new Error("gh failed"), fields));
}

const GH_PR_LIST = [
  {
    number: 74,
    title: "Implement #71",
    headRefName: "feat/other-account",
    author: { login: "second-account", is_bot: false },
    createdAt: "2026-09-21T10:00:00Z",
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", state: "SUCCESS" },
    ],
  },
  {
    number: 78,
    title: "Fix #71",
    headRefName: "fix/issue-71_abcd1234",
    author: { login: "frozename" },
    createdAt: "2026-09-21T11:00:00Z",
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
    ],
  },
  {
    number: 79,
    title: "Draft",
    headRefName: "agent/h-legacy",
    author: null,
    createdAt: "2026-09-21T12:00:00Z",
    statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }],
  },
  {
    number: 80,
    title: "No CI",
    headRefName: "docs/readme",
    author: { login: "frozename" },
    createdAt: "2026-09-21T13:00:00Z",
    statusCheckRollup: [],
  },
];

test("collectOpenPrs runs gh pr list in the given cwd with a timeout and parses the open PRs", async () => {
  const calls: { cmd: string; args: string[]; opts: { cwd: string; timeout: number } }[] = [];
  const run: OpenPrsRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve({ stdout: JSON.stringify(GH_PR_LIST), stderr: "" });
  };

  const result = await collectOpenPrs({ cwd: "/repo", run, timeoutMs: 1234 });

  expect(calls).toEqual([
    {
      cmd: "gh",
      args: [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,headRefName,author,createdAt,statusCheckRollup",
      ],
      opts: { cwd: "/repo", timeout: 1234 },
    },
  ]);
  expect(result).toEqual({
    reason: null,
    prs: [
      {
        number: 74,
        title: "Implement #71",
        head_ref: "feat/other-account",
        author: "second-account",
        created_at: "2026-09-21T10:00:00Z",
        checks: "success",
      },
      {
        number: 78,
        title: "Fix #71",
        head_ref: "fix/issue-71_abcd1234",
        author: "frozename",
        created_at: "2026-09-21T11:00:00Z",
        checks: "failure",
      },
      {
        number: 79,
        title: "Draft",
        head_ref: "agent/h-legacy",
        author: null,
        created_at: "2026-09-21T12:00:00Z",
        checks: "pending",
      },
      {
        number: 80,
        title: "No CI",
        head_ref: "docs/readme",
        author: "frozename",
        created_at: "2026-09-21T13:00:00Z",
        checks: "none",
      },
    ],
  });
});

test("collectOpenPrs reads status-context state when CheckRun fields are empty strings", async () => {
  const stdout = JSON.stringify([
    {
      ...GH_PR_LIST[0],
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS", state: "" },
        { status: "", conclusion: "", state: "ERROR" },
      ],
    },
  ]);
  const run: OpenPrsRunner = () => Promise.resolve({ stdout, stderr: "" });

  const result = await collectOpenPrs({ cwd: "/repo", run });

  expect(result.prs?.map((pr) => pr.checks)).toEqual(["failure"]);
});

test("collectOpenPrs returns an empty list when no PRs are open", async () => {
  const run: OpenPrsRunner = () => Promise.resolve({ stdout: "[]\n", stderr: "" });

  expect(await collectOpenPrs({ cwd: "/repo", run })).toEqual({ prs: [], reason: null });
});

test("collectOpenPrs returns null with a reason when gh is not installed", async () => {
  const result = await collectOpenPrs({ cwd: "/repo", run: failingRunner({ code: "ENOENT" }) });

  expect(result).toEqual({ prs: null, reason: "gh not installed" });
});

test("collectOpenPrs returns null with a reason when the repo is not on GitHub", async () => {
  const stderrs = [
    "failed to run git: fatal: not a git repository (or any of the parent directories): .git\n",
    "no git remotes found\n",
    "none of the git remotes configured for this repository point to a known GitHub host.\n",
  ];
  for (const stderr of stderrs) {
    const result = await collectOpenPrs({ cwd: "/repo", run: failingRunner({ code: 1, stderr }) });

    expect(result).toEqual({ prs: null, reason: "not a GitHub repository" });
  }
});

test("collectOpenPrs returns null with the first stderr line when gh pr list fails", async () => {
  const result = await collectOpenPrs({
    cwd: "/repo",
    run: failingRunner({ code: 1, stderr: "HTTP 401: Bad credentials\nsecond line\n" }),
  });

  expect(result).toEqual({ prs: null, reason: "gh pr list failed: HTTP 401: Bad credentials" });
});

test("collectOpenPrs returns null when the runner kills gh at the timeout", async () => {
  const result = await collectOpenPrs({
    cwd: "/repo",
    run: failingRunner({ code: null, killed: true, signal: "SIGTERM" }),
    timeoutMs: 250,
  });

  expect(result).toEqual({ prs: null, reason: "gh pr list timed out after 250ms" });
});

test("collectOpenPrs stops waiting at the timeout even when the runner never settles", async () => {
  const run: OpenPrsRunner = () => new Promise(() => undefined);

  const result = await collectOpenPrs({ cwd: "/repo", run, timeoutMs: 20 });

  expect(result).toEqual({ prs: null, reason: "gh pr list timed out after 20ms" });
});

test("collectOpenPrs returns null when gh prints output it cannot parse", async () => {
  for (const stdout of ["not json", '{"number":1}', '[{"number":"1"}]']) {
    const run: OpenPrsRunner = () => Promise.resolve({ stdout, stderr: "" });

    expect(await collectOpenPrs({ cwd: "/repo", run })).toEqual({
      prs: null,
      reason: "gh pr list returned unparseable output",
    });
  }
});

test("collectOpenPrs does not throw when the runner throws synchronously", async () => {
  const run: OpenPrsRunner = () => {
    throw new Error("spawn exploded");
  };

  expect(await collectOpenPrs({ cwd: "/repo", run })).toEqual({
    prs: null,
    reason: "gh pr list failed: spawn exploded",
  });
});
