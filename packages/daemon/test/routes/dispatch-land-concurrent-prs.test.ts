import {
  buildServices,
  type GhRunner,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { setPrincipalForTest } from "@src/auth.js";
import { landConcurrentPrsFinder } from "@src/routes/dispatch-land-concurrent-prs.js";
import {
  type DispatchLandDeps,
  dispatchLandRoute,
  dispatchLandTaskRoute,
} from "@src/routes/dispatch-land.js";

type RunGitResult = Awaited<ReturnType<DispatchLandDeps["runGit"]>>;
type LandMode = "gh" | "squash";

interface LandTaskBody {
  status: "queued" | "running" | "done" | "failed";
  result: Record<string, unknown> | null;
  error: { code: string } | null;
}

const OK: RunGitResult = { code: 0, stdout: "", stderr: "" };

const teardownOk: Services["worktreeManager"]["teardownWorktree"] = () =>
  Promise.resolve({ worktreeRemoved: true, branchDeleted: true });

function services(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const svc = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-land-concurrent-prs-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-09-21T12:00:00.000Z"),
    uuid: () => `id-${String(++n)}`,
  });
  svc.worktreeManager.teardownWorktree = teardownOk;
  return svc;
}

function seedHandoff(svc: Services, handoffId: string): void {
  svc.handoffWriter.createApproved({
    handoff_id: handoffId,
    ts: "2026-09-21T11:00:00.000Z",
    project_id: null,
    conversation_id: `c-${handoffId}`,
    from: "user",
    to: "codex",
    to_role: null,
    message: `dispatch ${handoffId}`,
    triggered_by_event_id: `evt-${handoffId}`,
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: "implement_small",
    use_worktree: true,
    parent_handoff_id: null,
    branch_base: null,
    open_pr_on_review: false,
  });
}

function runGit(handoffId: string, mode: LandMode): (args: string[]) => RunGitResult {
  let mainReads = 0;
  return (args) => {
    if (args[0] === "rev-parse" && args[1] === "main") {
      mainReads += 1;
      return { ...OK, stdout: `main-${String(mainReads)}\n` };
    }
    if (args[0] === "rev-parse") return { ...OK, stdout: `${handoffId}-head\n` };
    if (mode === "squash" && args[0] === "diff" && args[1] === "--cached") {
      return { ...OK, code: 1 };
    }
    return OK;
  };
}

function landDeps(
  handoffId: string,
  mode: LandMode,
  findConcurrentPrs: DispatchLandDeps["findConcurrentPrs"],
): DispatchLandDeps {
  const git = runGit(handoffId, mode);
  return {
    runGit: (args) => Promise.resolve(git(args)),
    gh: {
      listOpenPullRequestsByHead: () =>
        Promise.resolve(mode === "gh" ? [{ number: 78 }] : ([] as { number: number }[])),
      closePullRequest: () => Promise.resolve(),
      mergePullRequest: () => Promise.resolve(),
      getPullRequest: (prNumber) =>
        Promise.resolve({ number: prNumber, state: "MERGED", mergeCommitOid: "merge-oid" }),
    },
    now: () => new Date("2026-09-21T12:00:00.000Z"),
    findConcurrentPrs,
  };
}

function searchHit(number: number, headRefName: string, body: string): Record<string, unknown> {
  return {
    number,
    title: `PR ${String(number)}`,
    body,
    headRefName,
    author: { login: `author-${String(number)}` },
    url: `https://github.com/acme/repo/pull/${String(number)}`,
  };
}

function failingRunner(fields: Record<string, unknown>): GhRunner {
  return () => Promise.reject(Object.assign(new Error("gh failed"), fields));
}

const hangingRunner: GhRunner = () => new Promise(() => undefined);

function searchRunner(hits: Record<string, unknown>[], calls: string[][] = []): GhRunner {
  return (_cmd, args) => {
    calls.push(args);
    return Promise.resolve({ stdout: JSON.stringify(hits), stderr: "" });
  };
}

async function land(input: {
  handoffId: string;
  mode: LandMode;
  commitMessage: string;
  findConcurrentPrs: DispatchLandDeps["findConcurrentPrs"];
  warnings?: unknown[][];
}): Promise<LandTaskBody> {
  const svc = services();
  if (input.warnings) {
    const warnings = input.warnings;
    svc.log.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };
  }
  seedHandoff(svc, input.handoffId);
  const req = new Request("http://x/dispatch/land", {
    method: "POST",
    body: JSON.stringify({
      handoff_id: input.handoffId,
      commit_message: input.commitMessage,
      mode: input.mode,
      force: true,
    }),
  });
  setPrincipalForTest(req, { kind: "shared", via: "config" });
  const res = await dispatchLandRoute(
    req,
    svc,
    landDeps(input.handoffId, input.mode, input.findConcurrentPrs),
  );
  expect(res.status).toBe(202);
  const { task_id } = (await res.json()) as { task_id: string };
  for (let i = 0; i < 200; i += 1) {
    const body = (await dispatchLandTaskRoute(
      new Request(`http://x/dispatch/land/${task_id}`),
      svc,
      task_id,
    ).json()) as LandTaskBody;
    if (body.status === "done" || body.status === "failed") return body;
    await Bun.sleep(5);
  }
  throw new Error(`task ${task_id} did not finish`);
}

const OTHER_PR = {
  number: 74,
  title: "PR 74",
  head_ref: "feat/other-account",
  author: "author-74",
  url: "https://github.com/acme/repo/pull/74",
  issue: 71,
};

describe("dispatch-land concurrent open PR warning", () => {
  test("gh mode warns about another open PR on the same issue, excludes its own PR, and still lands", async () => {
    const calls: string[][] = [];
    const warnings: unknown[][] = [];

    const body = await land({
      handoffId: "h-dup",
      mode: "gh",
      commitMessage: "feat(core): implement the thing\n\nFixes #71",
      findConcurrentPrs: landConcurrentPrsFinder({
        cwd: "/repo",
        run: searchRunner(
          [searchHit(74, "feat/other-account", "Closes #71"), searchHit(78, "agent/h-dup", "#71")],
          calls,
        ),
      }),
      warnings,
    });

    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({
      ok: true,
      commit_sha: "merge-oid",
      pr_merged: true,
      pr_number: 78,
      concurrent_prs: [OTHER_PR],
    });
    expect(calls.map((args) => args.slice(0, 6))).toEqual([
      ["pr", "list", "--state", "open", "--search", "71 in:title,body"],
    ]);
    expect(warnings).toEqual([
      [
        { handoff_id: "h-dup", branch: "agent/h-dup", concurrent_prs: [OTHER_PR] },
        "dispatch-land: other open PRs reference the same issue as this land",
      ],
    ]);
  });

  test("squash mode carries the same warning so land-and-close can relay it", async () => {
    const body = await land({
      handoffId: "h-squash",
      mode: "squash",
      commitMessage: "fix(core): close the gap\n\nRefs #71",
      findConcurrentPrs: landConcurrentPrsFinder({
        cwd: "/repo",
        run: searchRunner([searchHit(74, "feat/other-account", "Implements #71")]),
      }),
    });

    expect(body.status).toBe("done");
    expect(body.result).toMatchObject({ ok: true, concurrent_prs: [OTHER_PR] });
  });

  test("omits the warning when only the landing PR references the issue", async () => {
    const warnings: unknown[][] = [];

    const body = await land({
      handoffId: "h-alone",
      mode: "gh",
      commitMessage: "Fixes #71",
      findConcurrentPrs: landConcurrentPrsFinder({
        cwd: "/repo",
        run: searchRunner([searchHit(78, "agent/h-alone", "Fixes #71")]),
      }),
      warnings,
    });

    expect(body.status).toBe("done");
    expect(body.result).not.toHaveProperty("concurrent_prs");
    expect(warnings).toEqual([]);
  });

  const failingRuns: [string, GhRunner][] = [
    ["gh is missing", failingRunner({ code: "ENOENT" })],
    ["the repo is not on GitHub", failingRunner({ code: 1, stderr: "no git remotes found\n" })],
    ["gh errors", failingRunner({ code: 1, stderr: "HTTP 502\n" })],
  ];
  for (const [name, run] of failingRuns) {
    test(`lands without a warning when ${name}`, async () => {
      const warnings: unknown[][] = [];

      const body = await land({
        handoffId: "h-fail",
        mode: "gh",
        commitMessage: "Fixes #71",
        findConcurrentPrs: landConcurrentPrsFinder({ cwd: "/repo", run }),
        warnings,
      });

      expect(body.status).toBe("done");
      expect(body.result).toMatchObject({ ok: true, pr_merged: true });
      expect(body.result).not.toHaveProperty("concurrent_prs");
      expect(warnings).toEqual([]);
    });
  }

  test("lands without a warning, bounded by the timeout, when gh never answers", async () => {
    const startedAt = Date.now();

    const body = await land({
      handoffId: "h-hang",
      mode: "gh",
      commitMessage: "Fixes #71",
      findConcurrentPrs: landConcurrentPrsFinder({
        cwd: "/repo",
        run: hangingRunner,
        timeoutMs: 50,
      }),
    });

    expect(body.status).toBe("done");
    expect(body.result).not.toHaveProperty("concurrent_prs");
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  test("lands without a warning when the injected finder throws", async () => {
    const body = await land({
      handoffId: "h-throw",
      mode: "gh",
      commitMessage: "Fixes #71",
      findConcurrentPrs: () => {
        throw new Error("finder exploded");
      },
    });

    expect(body.status).toBe("done");
    expect(body.result).not.toHaveProperty("concurrent_prs");
  });
});
