import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGhCliClient, type GhExec } from "@src/services/gh-client.js";

async function expectRejectsWithMessage(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("expected promise to reject with Error");
  expect(caught.message).toContain(expectedMessage);
}

describe("createGhCliClient", () => {
  test("default gh exec times out slow subprocesses", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "gh-client-timeout-"));
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, "#!/usr/bin/env bun\nawait Bun.sleep(200);\nconsole.log('octocat');\n");
    chmodSync(ghPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const client = createGhCliClient({ repoDir: binDir, execTimeoutMs: 20 });
      if (!client.getAuthenticatedLogin) throw new Error("missing getAuthenticatedLogin");
      await expectRejectsWithMessage(client.getAuthenticatedLogin(), "timed out after 20ms");
    } finally {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("createIssue returns number/url from gh issue create stdout URL", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: "https://github.com/frozename/penumbra/issues/42\n",
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });

    const out = await client.createIssue({
      repo: "frozename/penumbra",
      title: "Task title",
      body: "Task body",
      labels: ["tasks", "phase-2"],
      assignees: ["frozename"],
    });

    expect(calls).toEqual([
      [
        "issue",
        "create",
        "--repo",
        "frozename/penumbra",
        "--title",
        "Task title",
        "--body",
        "Task body",
        "--label",
        "tasks",
        "--label",
        "phase-2",
        "--assignee",
        "frozename",
      ],
    ]);
    expect(out).toEqual({
      number: 42,
      url: "https://github.com/frozename/penumbra/issues/42",
    });
  });

  test("createIssue throws if gh output has no issue URL", async () => {
    const exec: GhExec = () =>
      Promise.resolve({
        stdout: "created\n",
        stderr: "",
        exitCode: 0,
      });
    const client = createGhCliClient({ exec });

    await expectRejectsWithMessage(
      client.createIssue({
        repo: "frozename/penumbra",
        title: "Task title",
      }),
      "did not print an issue URL",
    );
  });

  test("createIssue retries once after dropping unknown labels", async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });
    try {
      const exec: GhExec = (args) => {
        calls.push(args);
        if (calls.length === 1) {
          return Promise.resolve({
            stdout: "",
            stderr: "could not add label: 'task-draft' not found",
            exitCode: 1,
          });
        }
        return Promise.resolve({
          stdout: "https://github.com/frozename/penumbra/issues/43\n",
          stderr: "",
          exitCode: 0,
        });
      };
      const client = createGhCliClient({ exec });

      const out = await client.createIssue({
        repo: "frozename/penumbra",
        title: "Task title",
        labels: ["task-draft", "refiner-promoted", "e2e-test"],
      });

      expect(calls).toEqual([
        [
          "issue",
          "create",
          "--repo",
          "frozename/penumbra",
          "--title",
          "Task title",
          "--label",
          "task-draft",
          "--label",
          "refiner-promoted",
          "--label",
          "e2e-test",
        ],
        [
          "issue",
          "create",
          "--repo",
          "frozename/penumbra",
          "--title",
          "Task title",
          "--label",
          "refiner-promoted",
          "--label",
          "e2e-test",
        ],
      ]);
      expect(warnings).toEqual([
        'gh-client: dropping unknown labels: ["task-draft"] for repo=frozename/penumbra',
      ]);
      expect(out).toEqual({
        number: 43,
        url: "https://github.com/frozename/penumbra/issues/43",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("createIssue drops multiple unknown labels from one error and retries once", async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });
    try {
      const exec: GhExec = (args) => {
        calls.push(args);
        if (calls.length === 1) {
          return Promise.resolve({
            stdout: "",
            stderr: "could not add label: 'a' not found; could not add label: 'b' not found",
            exitCode: 1,
          });
        }
        return Promise.resolve({
          stdout: "https://github.com/frozename/penumbra/issues/44\n",
          stderr: "",
          exitCode: 0,
        });
      };
      const client = createGhCliClient({ exec });

      const out = await client.createIssue({
        repo: "frozename/penumbra",
        title: "Task title",
        labels: ["a", "b", "keep"],
      });

      expect(calls).toEqual([
        [
          "issue",
          "create",
          "--repo",
          "frozename/penumbra",
          "--title",
          "Task title",
          "--label",
          "a",
          "--label",
          "b",
          "--label",
          "keep",
        ],
        [
          "issue",
          "create",
          "--repo",
          "frozename/penumbra",
          "--title",
          "Task title",
          "--label",
          "keep",
        ],
      ]);
      expect(warnings).toEqual([
        'gh-client: dropping unknown labels: ["a","b"] for repo=frozename/penumbra',
      ]);
      expect(out).toEqual({
        number: 44,
        url: "https://github.com/frozename/penumbra/issues/44",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("createIssue propagates non-label errors without retry", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: "",
        stderr: "GraphQL: Something else went wrong",
        exitCode: 1,
      });
    };
    const client = createGhCliClient({ exec });

    await expectRejectsWithMessage(
      client.createIssue({
        repo: "frozename/penumbra",
        title: "Task title",
        labels: ["keep"],
      }),
      "gh issue create --repo frozename/penumbra --title Task title --label keep failed: GraphQL: Something else went wrong",
    );

    expect(calls).toHaveLength(1);
  });

  test("createIssue succeeds with valid labels without retry", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: "https://github.com/frozename/penumbra/issues/45\n",
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });

    const out = await client.createIssue({
      repo: "frozename/penumbra",
      title: "Task title",
      labels: ["keep"],
    });

    expect(calls).toHaveLength(1);
    expect(out).toEqual({
      number: 45,
      url: "https://github.com/frozename/penumbra/issues/45",
    });
  });

  test("commentIssue invokes gh issue comment and returns parsed URL from stdout", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: "https://github.com/frozename/penumbra/issues/1#issuecomment-123456789\n",
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });
    const out = await client.commentIssue("frozename/penumbra", 1, "hello");

    expect(calls[0]).toEqual([
      "issue",
      "comment",
      "1",
      "--repo",
      "frozename/penumbra",
      "--body",
      "hello",
    ]);
    expect(out).toEqual({
      comment_url: "https://github.com/frozename/penumbra/issues/1#issuecomment-123456789",
    });
  });

  test("listComments invokes gh api with since filter and maps comments from raw paginated output", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: JSON.stringify([
          [
            {
              id: 9001,
              user: { login: "octocat" },
              body: "Looks good",
              created_at: "2026-05-08T17:00:00Z",
              html_url: "https://github.com/frozename/penumbra/issues/1#issuecomment-9001",
            },
          ],
          [
            {
              id: "9002",
              user: {},
              body: null,
              created_at: null,
              url: "https://github.com/frozename/penumbra/issues/1#issuecomment-9002",
            },
          ],
        ]),
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });
    const out = await client.listComments("frozename/penumbra", 1, {
      since: "2026-05-08T16:00:00.000Z",
    });

    expect(calls[0]).toEqual([
      "api",
      "repos/frozename/penumbra/issues/1/comments?since=2026-05-08T16%3A00%3A00.000Z",
      "--paginate",
      "--slurp",
    ]);
    expect(out).toEqual([
      {
        id: "9001",
        author_login: "octocat",
        body: "Looks good",
        created_at: "2026-05-08T17:00:00Z",
        url: "https://github.com/frozename/penumbra/issues/1#issuecomment-9001",
      },
      {
        id: "9002",
        author_login: "",
        body: "",
        created_at: "",
        url: "https://github.com/frozename/penumbra/issues/1#issuecomment-9002",
      },
    ]);
  });

  test("listIssuesUpdatedSince makes one paginated gh api call and reads server time from the first page", async () => {
    const calls: string[][] = [];
    const page = (date: string, rows: string[]): string =>
      [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json; charset=utf-8\r",
        `Date: ${date}\r`,
        'Link: <https://api.github.com/repos/frozename/penumbra/issues?page=2>; rel="next"\r',
        "\r",
        ...rows,
      ].join("\n");
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: `${page("Tue, 20 Oct 2026 03:14:34 GMT", ["215\t2026-10-20T02:03:57Z", "190\t2026-10-20T02:03:57Z"])}\n${page("Tue, 20 Oct 2026 03:14:35 GMT", ["135\t2026-10-20T02:03:47Z"])}\n`,
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });
    if (!client.listIssuesUpdatedSince) throw new Error("missing listIssuesUpdatedSince");

    const out = await client.listIssuesUpdatedSince("frozename/penumbra", "2026-10-20T02:00:00Z");

    expect(calls).toEqual([
      [
        "api",
        "--include",
        "--paginate",
        "repos/frozename/penumbra/issues?state=all&since=2026-10-20T02%3A00%3A00Z&per_page=100",
        "--jq",
        ".[] | [.number, .updated_at] | @tsv",
      ],
    ]);
    expect(out).toEqual({
      serverTime: "2026-10-20T03:14:34.000Z",
      issues: [
        { number: 215, updatedAt: "2026-10-20T02:03:57Z" },
        { number: 190, updatedAt: "2026-10-20T02:03:57Z" },
        { number: 135, updatedAt: "2026-10-20T02:03:47Z" },
      ],
    });
  });

  test("listIssuesUpdatedSince reports a null server time when no Date header is present", async () => {
    const exec: GhExec = () =>
      Promise.resolve({
        stdout: "HTTP/1.1 200 OK\n\n7\t2026-10-20T01:00:00Z\n",
        stderr: "",
        exitCode: 0,
      });
    const client = createGhCliClient({ exec });
    if (!client.listIssuesUpdatedSince) throw new Error("missing listIssuesUpdatedSince");

    const out = await client.listIssuesUpdatedSince("frozename/penumbra", "2026-10-20T00:00:00Z");

    expect(out).toEqual({
      serverTime: null,
      issues: [{ number: 7, updatedAt: "2026-10-20T01:00:00Z" }],
    });
  });

  test("listIssuesUpdatedSince rejects when gh fails", async () => {
    const exec: GhExec = () =>
      Promise.resolve({ stdout: "", stderr: "HTTP 503: Service Unavailable", exitCode: 1 });
    const client = createGhCliClient({ exec });
    if (!client.listIssuesUpdatedSince) throw new Error("missing listIssuesUpdatedSince");

    await expectRejectsWithMessage(
      client.listIssuesUpdatedSince("frozename/penumbra", "2026-10-20T00:00:00Z"),
      "HTTP 503",
    );
  });

  test("getAuthenticatedLogin reads login via gh api user", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: "penumbra-bot\n",
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });
    if (!client.getAuthenticatedLogin) throw new Error("missing getAuthenticatedLogin");
    const login = await client.getAuthenticatedLogin();

    expect(calls[0]).toEqual(["api", "user", "--jq", ".login"]);
    expect(login).toBe("penumbra-bot");
  });

  test("mergePullRequest builds squash argv with subject and body", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    };
    const client = createGhCliClient({ exec });
    if (!client.mergePullRequest) throw new Error("missing mergePullRequest");

    await client.mergePullRequest({
      number: 42,
      method: "squash",
      subject: "feat(core): merge via gh",
      body: "full body text",
    });

    expect(calls).toEqual([
      [
        "pr",
        "merge",
        "42",
        "--squash",
        "--subject",
        "feat(core): merge via gh",
        "--body",
        "full body text",
      ],
    ]);
  });

  test("mergePullRequest builds merge argv without subject/body", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    };
    const client = createGhCliClient({ exec });
    if (!client.mergePullRequest) throw new Error("missing mergePullRequest");

    await client.mergePullRequest({ number: 7, method: "merge" });

    expect(calls).toEqual([["pr", "merge", "7", "--merge"]]);
  });

  test("mergePullRequest builds rebase argv with deleteBranch", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    };
    const client = createGhCliClient({ exec });
    if (!client.mergePullRequest) throw new Error("missing mergePullRequest");

    await client.mergePullRequest({ number: 99, method: "rebase", deleteBranch: true });

    expect(calls).toEqual([["pr", "merge", "99", "--rebase", "--delete-branch"]]);
  });

  test("mergePullRequest propagates gh errors", async () => {
    const exec: GhExec = () =>
      Promise.resolve({
        stdout: "",
        stderr: "GraphQL: merge conflict",
        exitCode: 1,
      });
    const client = createGhCliClient({ exec });
    if (!client.mergePullRequest) throw new Error("missing mergePullRequest");

    await expectRejectsWithMessage(
      client.mergePullRequest({ number: 1, method: "squash" }),
      "gh pr merge 1 --squash failed: GraphQL: merge conflict",
    );
  });

  test("getPullRequest parses state and mergeCommit oid from gh pr view", async () => {
    const calls: string[][] = [];
    const exec: GhExec = (args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc123def456" } }),
        stderr: "",
        exitCode: 0,
      });
    };
    const client = createGhCliClient({ exec });
    if (!client.getPullRequest) throw new Error("missing getPullRequest");

    const pr = await client.getPullRequest(42);

    expect(calls).toEqual([["pr", "view", "42", "--json", "state,mergeCommit"]]);
    expect(pr).toEqual({ number: 42, state: "MERGED", mergeCommitOid: "abc123def456" });
  });

  test("getPullRequest returns null mergeCommitOid when mergeCommit is absent", async () => {
    const exec: GhExec = () =>
      Promise.resolve({
        stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }),
        stderr: "",
        exitCode: 0,
      });
    const client = createGhCliClient({ exec });
    if (!client.getPullRequest) throw new Error("missing getPullRequest");

    const pr = await client.getPullRequest(7);
    expect(pr).toEqual({ number: 7, state: "OPEN", mergeCommitOid: null });
  });

  test("getPullRequest normalizes CLOSED state", async () => {
    const exec: GhExec = () =>
      Promise.resolve({
        stdout: JSON.stringify({ state: "closed", mergeCommit: null }),
        stderr: "",
        exitCode: 0,
      });
    const client = createGhCliClient({ exec });
    if (!client.getPullRequest) throw new Error("missing getPullRequest");

    const pr = await client.getPullRequest(9);
    expect(pr.state).toBe("CLOSED");
  });

  test("default exec runs gh with repoDir as cwd", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "gh-client-repodir-"));
    const ghPath = join(binDir, "gh");
    // /bin/sh + the `pwd` builtin so the shim needs nothing else on PATH, and
    // PATH is set to binDir ALONE so a real installed `gh` cannot win the
    // lookup and answer with the actual authenticated login instead.
    writeFileSync(ghPath, "#!/bin/sh\npwd\n");
    chmodSync(ghPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const client = createGhCliClient({ repoDir: binDir });
      if (!client.getAuthenticatedLogin) throw new Error("missing getAuthenticatedLogin");
      const cwdOutput = await client.getAuthenticatedLogin();
      // `pwd` reports the physical path; on macOS mkdtemp hands back the
      // /var -> /private/var symlink, so compare resolved paths.
      expect(realpathSync(cwdOutput ?? "")).toBe(realpathSync(binDir));
    } finally {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
