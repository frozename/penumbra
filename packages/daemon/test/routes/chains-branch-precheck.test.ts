import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  availableBranchNameBestEffort,
  type BranchProbeRunner,
} from "@src/routes/chains-branch-precheck.js";

const REQUESTED = "feat/full-task-pool_d34db33f";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-branch-precheck-"));
  tempDirs.push(dir);
  return dir;
}

function showRef(branch: string): string[] {
  return ["-C", "/repo", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`];
}

function stubGit(existing: ReadonlySet<string>): {
  runGit: BranchProbeRunner;
  calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const runGit: BranchProbeRunner = (args) => {
    calls.push(args);
    const branch = (args.at(-1) ?? "").replace(/^refs\/heads\//, "");
    return existing.has(branch)
      ? Promise.resolve()
      : Promise.reject(new Error(`git exited 1 for ${branch}`));
  };
  return { runGit, calls };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("returns the requested name when the root is not a git repository", async () => {
  expect(await availableBranchNameBestEffort(tempDir(), REQUESTED)).toBe(REQUESTED);
});

test("returns the requested name when no project root is known", async () => {
  expect(await availableBranchNameBestEffort(undefined, REQUESTED)).toBe(REQUESTED);
});

test("probes git once when the requested name is free", async () => {
  const { runGit, calls } = stubGit(new Set());

  expect(await availableBranchNameBestEffort("/repo", REQUESTED, runGit)).toBe(REQUESTED);
  expect(calls).toEqual([showRef(REQUESTED)]);
});

test("suffixes past every existing candidate", async () => {
  const { runGit, calls } = stubGit(new Set([REQUESTED, `${REQUESTED}-2`]));

  expect(await availableBranchNameBestEffort("/repo", REQUESTED, runGit)).toBe(`${REQUESTED}-3`);
  expect(calls).toEqual([showRef(REQUESTED), showRef(`${REQUESTED}-2`), showRef(`${REQUESTED}-3`)]);
});

test("throws once all 99 candidates exist", async () => {
  const runGit: BranchProbeRunner = () => Promise.resolve();

  const error = await availableBranchNameBestEffort("/repo", REQUESTED, runGit).then(
    () => null,
    (err: unknown) => err,
  );

  expect(error).toEqual(new Error(`branch_name_collision_exhausted: ${REQUESTED}`));
});

test("bounds every probe at 5s and treats a timed-out probe as free", async () => {
  const timeouts: number[] = [];
  const runGit: BranchProbeRunner = (args, opts) => {
    timeouts.push(opts.timeout);
    if (args.at(-1) === `refs/heads/${REQUESTED}`) return Promise.resolve();
    const timedOut = Object.assign(new Error("Command failed: git show-ref"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    return Promise.reject(timedOut);
  };

  expect(await availableBranchNameBestEffort("/repo", REQUESTED, runGit)).toBe(`${REQUESTED}-2`);
  expect(timeouts).toEqual([5_000, 5_000]);
});
