import { createGhCliClient, type GhExec } from "@src/services/gh-client.js";
import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
