import { buildRegistry } from "@penumbra/workflows";
import { expect, spyOn, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { workflowsRunRoute } from "@src/routes/workflows.js";
import {
  inspectWorktreeForHandoff,
  type WorktreeInspection,
  type WorktreeInspectionCommandRunner,
} from "@src/routes/worktree-inspection.js";
import { worktreesInspectRoute } from "@src/routes/worktrees.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

import {
  controlledGitArgs,
  createInspectionWorktree,
  createWorktreeInspectionHarness,
  gitOutput,
  seedInspectionHandoff,
  type WorktreeInspectionHarness,
} from "../helpers/worktree-inspection.js";

const execFile = promisify(execFileCb);
const WORKFLOW_SOURCE = `import type { WorkflowFn, WorkflowSpec } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'worktree-inspection',
  description: 'reads a bounded candidate snapshot',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  const delayMs = typeof ctx.args.delay_ms === 'number' ? ctx.args.delay_ms : 0;
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  return {
    available: typeof ctx.worktreeInspect === 'function',
    inspection: await ctx.worktreeInspect?.(String(ctx.args.handoff_id)),
  };
};
`;

function actualGitRunner(harness: WorktreeInspectionHarness): WorktreeInspectionCommandRunner {
  return async (args, opts) => {
    return await execFile("git", controlledGitArgs(args), {
      ...opts,
      encoding: "utf8",
      env: harness.gitEnv,
    });
  };
}

async function installWorkflow(harness: WorktreeInspectionHarness): Promise<void> {
  const playbooksDir = join(harness.root, "playbooks");
  const workflowsDir = join(harness.root, "workflows");
  const workflowDir = join(workflowsDir, "worktree-inspection");
  mkdirSync(playbooksDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, "workflow.ts"), WORKFLOW_SOURCE);
  harness.services.workflowRegistry = await buildRegistry({ playbooksDir, workflowsDir });
  harness.services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => `workflow-run-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
    clock: () => new Date(),
    db: harness.db,
    storageRoot: harness.root,
  });
}

async function runInspectionWorkflow(
  harness: WorktreeInspectionHarness,
  handoffId: string,
  wait: boolean,
  runTimeoutMs?: number,
  delayMs?: number,
): Promise<Response> {
  return await workflowsRunRoute(
    new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "worktree-inspection",
        cwd: harness.repoRoot,
        wait,
        args: {
          handoff_id: handoffId,
          ...(runTimeoutMs === undefined ? {} : { run_timeout_ms: runTimeoutMs }),
          ...(delayMs === undefined ? {} : { delay_ms: delayMs }),
        },
      }),
    }),
    harness.services,
  );
}

function expectInspectionShape(value: WorktreeInspection, handoffId: string): void {
  expect(value).toMatchObject({
    worktree: { handoffId },
    branch_name: `agent/${handoffId}`,
    dirty: false,
    truncation: {
      diff_against_main: false,
      branch_log: false,
      total: false,
    },
  });
  expect(value.head_sha).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  expect(value.diff_against_main).toContain("candidate.txt");
  expect(value.branch_log).toContain("candidate");
}

test("unknown and foreign-project handoffs perform zero Git reads", async () => {
  const harness = createWorktreeInspectionHarness();
  let gitReads = 0;
  const runGit: WorktreeInspectionCommandRunner = () => {
    gitReads += 1;
    return Promise.reject(new Error("Git must not run"));
  };
  try {
    const getWorktree = spyOn(harness.services.worktreeManager, "getWorktree");
    const unknown = await inspectWorktreeForHandoff(harness.services, "unknown", {
      expectedProjectId: "project-a",
      runGit,
    });
    const foreignId = "22222222-2222-4222-8222-222222222222";
    seedInspectionHandoff(harness.services, {
      handoffId: foreignId,
      projectId: "project-b",
      branchName: `agent/${foreignId}`,
    });
    const foreign = await inspectWorktreeForHandoff(harness.services, foreignId, {
      expectedProjectId: "project-a",
      runGit,
    });

    expect(unknown).toMatchObject({ ok: false, code: "not_found" });
    expect(foreign).toMatchObject({ ok: false, code: "not_found" });
    expect(getWorktree).toHaveBeenCalledTimes(0);
    expect(gitReads).toBe(0);
  } finally {
    harness.cleanup();
  }
});

test("inspection binds the database branch, manager handle, and symbolic branch", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    harness.db
      .query("UPDATE handoffs SET branch_name = ? WHERE handoff_id = ?")
      .run("agent/not-the-candidate", handle.handoffId);

    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
    });
    expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
  } finally {
    harness.cleanup();
  }
});

test("a stable dirty tree is reported but not certified clean", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    writeFileSync(join(handle.path, "dirty.txt"), "uncommitted\n");
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.inspection.dirty).toBe(true);
    expect(result.inspection.diff_against_main).toContain("?? dirty.txt");
  } finally {
    harness.cleanup();
  }
});

test("inspection does not execute repository-configured helpers", async () => {
  const observations: {
    helperCalled: boolean;
    result: Awaited<ReturnType<typeof inspectWorktreeForHandoff>>;
  }[] = [];

  for (const helperKind of ["external", "textconv", "fsmonitor"] as const) {
    const harness = createWorktreeInspectionHarness();
    try {
      const helper = join(harness.root, `${helperKind}-helper.sh`);
      const canary = `${helper}.canary`;
      writeFileSync(
        helper,
        helperKind === "textconv"
          ? '#!/bin/sh\nprintf "called\\n" >> "$0.canary"\n/bin/cat "$1"\n'
          : '#!/bin/sh\nprintf "called\\n" >> "$0.canary"\nexit 0\n',
      );
      chmodSync(helper, 0o700);

      if (helperKind === "external") {
        gitOutput(harness, harness.repoRoot, ["config", "diff.external", helper]);
      } else if (helperKind === "textconv") {
        writeFileSync(join(harness.repoRoot, ".gitattributes"), "*.txt diff=canary\n");
        gitOutput(harness, harness.repoRoot, ["add", ".gitattributes"]);
        gitOutput(harness, harness.repoRoot, ["commit", "-m", "configure textconv"]);
        gitOutput(harness, harness.repoRoot, ["config", "diff.canary.textconv", helper]);
      } else {
        gitOutput(harness, harness.repoRoot, ["config", "core.fsmonitor", helper]);
      }

      const handle = await createInspectionWorktree(harness);
      if (existsSync(canary)) unlinkSync(canary);
      const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
        expectedProjectId: "project-a",
        runGit: actualGitRunner(harness),
      });
      observations.push({ helperCalled: existsSync(canary), result });
    } finally {
      harness.cleanup();
    }
  }

  expect(observations.map(({ helperCalled }) => helperCalled)).toEqual([false, false, false]);
  for (const { result } of observations) {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expectInspectionShape(result.inspection, result.inspection.worktree.handoffId);
  }
});

test("a HEAD ABA during Git reads invalidates the snapshot", async () => {
  const harness = createWorktreeInspectionHarness();
  let originalRefBytes: Buffer | undefined;
  let branchRef: string | undefined;
  let branchRefPath: string | undefined;
  let originalHead: string | undefined;
  try {
    const handle = await createInspectionWorktree(harness);
    branchRef = `refs/heads/${handle.branchName}`;
    branchRefPath = join(
      harness.repoRoot,
      gitOutput(harness, harness.repoRoot, ["rev-parse", "--git-path", branchRef]).trim(),
    );
    originalRefBytes = readFileSync(branchRefPath);
    originalHead = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    const actual = actualGitRunner(harness);
    let mutated = false;
    let restored = false;
    const runGit: WorktreeInspectionCommandRunner = async (args, opts) => {
      const result = await actual(args, opts);
      if (!mutated && args.includes("log")) {
        mutated = true;
        writeFileSync(join(handle.path, "raced.txt"), "changed during inspection\n");
        gitOutput(harness, handle.path, ["add", "raced.txt"]);
        gitOutput(harness, handle.path, ["commit", "-m", "race"]);
        gitOutput(harness, handle.path, ["reset", "--hard", originalHead ?? ""]);
        restored = true;
      }
      return result;
    };

    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit,
    });
    expect(mutated).toBe(true);
    expect(restored).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
  } finally {
    if (branchRef && branchRefPath && originalHead && originalRefBytes) {
      gitOutput(harness, harness.repoRoot, ["update-ref", branchRef, originalHead]);
      expect(readFileSync(branchRefPath).toString("hex")).toBe(originalRefBytes.toString("hex"));
    }
    harness.cleanup();
  }
});

test("inspection rejects an unavailable branch reflog before accepting an ABA-prone snapshot", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const originalHead = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    gitOutput(harness, harness.repoRoot, ["config", "core.logAllRefUpdates", "false"]);
    const reflogPath = gitOutput(harness, harness.repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      `logs/refs/heads/${handle.branchName}`,
    ]).trim();
    unlinkSync(reflogPath);
    expect(
      gitOutput(harness, handle.path, [
        "reflog",
        "show",
        "-1",
        "--format=%H:%gD",
        handle.branchName,
      ]),
    ).toBe("");

    const actual = actualGitRunner(harness);
    let mutated = false;
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: async (args, opts) => {
        const gitResult = await actual(args, opts);
        if (!mutated && args.includes("log")) {
          mutated = true;
          writeFileSync(join(handle.path, "aba.txt"), "transient\n");
          gitOutput(harness, handle.path, ["add", "aba.txt"]);
          gitOutput(harness, handle.path, ["commit", "-m", "transient ABA"]);
          gitOutput(harness, handle.path, ["reset", "--hard", originalHead]);
        }
        return gitResult;
      },
    });

    expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
  } finally {
    harness.cleanup();
  }
});

test("inspection keeps diff and log on the same captured main-to-HEAD range", async () => {
  const harness = createWorktreeInspectionHarness();
  let originalMain: string | undefined;
  let mainRefPath: string | undefined;
  let originalMainRefBytes: Buffer | undefined;
  try {
    const handle = await createInspectionWorktree(harness);
    originalMain = gitOutput(harness, harness.repoRoot, ["rev-parse", "main"]).trim();
    mainRefPath = join(
      harness.repoRoot,
      gitOutput(harness, harness.repoRoot, ["rev-parse", "--git-path", "refs/heads/main"]).trim(),
    );
    originalMainRefBytes = readFileSync(mainRefPath);
    const candidateHead = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    const actual = actualGitRunner(harness);
    let mainAdvanced = false;
    const runGit: WorktreeInspectionCommandRunner = async (args, opts) => {
      const result = await actual(args, opts);
      if (!mainAdvanced && args.includes("diff")) {
        gitOutput(harness, harness.repoRoot, [
          "update-ref",
          "refs/heads/main",
          candidateHead,
          originalMain ?? "",
        ]);
        mainAdvanced = true;
      }
      return result;
    };

    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit,
    });

    expect(mainAdvanced).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.inspection.diff_against_main).toContain("candidate.txt");
    expect(result.inspection.branch_log).toContain("candidate");
  } finally {
    if (mainRefPath && originalMain && originalMainRefBytes) {
      gitOutput(harness, harness.repoRoot, ["update-ref", "refs/heads/main", originalMain]);
      expect(readFileSync(mainRefPath).toString("hex")).toBe(originalMainRefBytes.toString("hex"));
    }
    harness.cleanup();
  }
});

test("expired and mid-call workflow deadlines stop further Git reads", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    let expiredReads = 0;
    const expired = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      deadline: () => ({ remaining_ms: 0, expired: true }),
      runGit: () => {
        expiredReads += 1;
        return Promise.reject(new Error("must not run"));
      },
    });
    expect(expired).toMatchObject({ ok: false, code: "inspection_failed" });
    expect(expiredReads).toBe(0);

    const actual = actualGitRunner(harness);
    let midCallExpired = false;
    let midCallReads = 0;
    const during = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      deadline: () => ({ remaining_ms: midCallExpired ? 0 : 5_000, expired: midCallExpired }),
      runGit: async (args, opts) => {
        midCallReads += 1;
        const result = await actual(args, opts);
        midCallExpired = true;
        return result;
      },
    });
    expect(during).toMatchObject({ ok: false, code: "inspection_failed" });
    expect(midCallReads).toBe(1);
  } finally {
    harness.cleanup();
  }
});

test("command timeout, output overflow, and Git errors are explicit failures", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    for (const error of [
      Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      Object.assign(new Error("git failed"), { code: 128 }),
    ]) {
      const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
        expectedProjectId: "project-a",
        runGit: () => Promise.reject(error),
      });
      expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
      if (result.ok) throw new Error("expected inspection failure");
      expect(result.message).toContain(error.message);
    }
  } finally {
    harness.cleanup();
  }
});

test("diff and log output are independently bounded with explicit truncation", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness, { commit: false });
    writeFileSync(join(handle.path, "large.txt"), `${"x".repeat(20_000)}\n`);
    gitOutput(harness, handle.path, ["add", "large.txt"]);
    gitOutput(harness, handle.path, ["commit", "-m", "large candidate"]);
    for (let index = 0; index < 48; index += 1) {
      gitOutput(harness, handle.path, [
        "commit",
        "--allow-empty",
        "-m",
        `log-${String(index)}-${"y".repeat(180)}`,
      ]);
    }

    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(Buffer.byteLength(result.inspection.diff_against_main)).toBeLessThanOrEqual(10 * 1024);
    expect(Buffer.byteLength(result.inspection.branch_log)).toBeLessThanOrEqual(8 * 1024);
    expect(result.inspection.truncation).toEqual({
      diff_against_main: true,
      branch_log: true,
      total: true,
    });
  } finally {
    harness.cleanup();
  }
});

test("subprocess output beyond the hard capture cap fails closed", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness, { commit: false });
    writeFileSync(join(handle.path, "overflow.txt"), `${"z".repeat(90_000)}\n`);
    gitOutput(harness, handle.path, ["add", "overflow.txt"]);
    gitOutput(harness, handle.path, ["commit", "-m", "overflow"]);

    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
    });
    expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
  } finally {
    harness.cleanup();
  }
});

test("detached HEAD, wrong canonical top-level, and missing worktrees fail closed", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const detached = await createInspectionWorktree(harness);
    gitOutput(harness, detached.path, ["checkout", "--detach"]);
    expect(
      await inspectWorktreeForHandoff(harness.services, detached.handoffId, {
        expectedProjectId: "project-a",
      }),
    ).toMatchObject({ ok: false, code: "inspection_failed" });

    const wrongRootId = "33333333-3333-4333-8333-333333333333";
    const wrongRoot = await createInspectionWorktree(harness, { handoffId: wrongRootId });
    const nested = join(wrongRoot.path, "nested");
    const nestedLink = join(harness.root, "nested-link");
    mkdirSync(nested);
    symlinkSync(nested, nestedLink, "dir");
    const getWorktree = spyOn(harness.services.worktreeManager, "getWorktree").mockImplementation(
      (handoffId, projectId) =>
        handoffId === wrongRootId
          ? { ...wrongRoot, path: nestedLink, projectId }
          : handoffId === detached.handoffId
            ? detached
            : null,
    );
    expect(
      await inspectWorktreeForHandoff(harness.services, wrongRootId, {
        expectedProjectId: "project-a",
      }),
    ).toMatchObject({ ok: false, code: "inspection_failed" });
    getWorktree.mockRestore();

    const missingId = "44444444-4444-4444-8444-444444444444";
    seedInspectionHandoff(harness.services, {
      handoffId: missingId,
      projectId: "project-a",
      branchName: `agent/${missingId}`,
    });
    expect(
      await inspectWorktreeForHandoff(harness.services, missingId, {
        expectedProjectId: "project-a",
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  } finally {
    harness.cleanup();
  }
});

test("an exact-root symlink resolves to the same canonical worktree", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const link = join(harness.root, "worktree-link");
    symlinkSync(handle.path, link, "dir");
    const getWorktree = spyOn(harness.services.worktreeManager, "getWorktree").mockReturnValue({
      ...handle,
      path: link,
    });
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
    });
    expect(result.ok).toBe(true);
    getWorktree.mockRestore();
  } finally {
    harness.cleanup();
  }
});

test("wait:true exposes the same inspection fields as the HTTP route", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    await installWorkflow(harness);
    const httpResponse = await worktreesInspectRoute(
      new Request(`http://localhost/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
    );
    const httpInspection = (await httpResponse.json()) as WorktreeInspection;
    const response = await runInspectionWorkflow(harness, handle.handoffId, true);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome?: string;
      runResult?: { available?: boolean; inspection?: WorktreeInspection | null };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.available).toBe(true);
    expect(body.runResult?.inspection).toEqual(httpInspection);
    const inspection = body.runResult?.inspection;
    expect(inspection).toBeDefined();
    if (!inspection) throw new Error("expected workflow inspection");
    expectInspectionShape(inspection, handle.handoffId);
  } finally {
    harness.cleanup();
  }
});

test("wait:false executes with the same project-scoped inspection capability", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    await installWorkflow(harness);
    const response = await runInspectionWorkflow(harness, handle.handoffId, false);
    expect(response.status).toBe(200);
    const started = (await response.json()) as { workflow_run_id?: string };
    expect(started.workflow_run_id).toBeString();
    const record = await harness.services.workflowRuns?.waitForResult(
      started.workflow_run_id ?? "",
      5_000,
    );
    const result = record?.result as {
      outcome?: string;
      runResult?: { available?: boolean; inspection?: WorktreeInspection | null };
    };
    expect(record?.status).toBe("completed");
    expect(result.outcome).toBe("success");
    expect(result.runResult?.available).toBe(true);
    const inspection = result.runResult?.inspection;
    expect(inspection).toBeDefined();
    if (!inspection) throw new Error("expected workflow inspection");
    expectInspectionShape(inspection, handle.handoffId);
  } finally {
    harness.cleanup();
  }
});

test("workflow capability hides unknown and foreign-project handoffs", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    await installWorkflow(harness);
    const foreignId = "55555555-5555-4555-8555-555555555555";
    seedInspectionHandoff(harness.services, {
      handoffId: foreignId,
      projectId: "project-b",
      branchName: `agent/${foreignId}`,
    });
    const getWorktree = spyOn(harness.services.worktreeManager, "getWorktree");

    for (const handoffId of ["unknown", foreignId]) {
      const response = await runInspectionWorkflow(harness, handoffId, true);
      const body = (await response.json()) as {
        outcome?: string;
        runResult?: { available?: boolean; inspection?: WorktreeInspection | null };
      };
      expect(body.outcome).toBe("success");
      expect(body.runResult?.available).toBe(true);
      expect(body.runResult?.inspection).toBeNull();
    }
    expect(getWorktree).toHaveBeenCalledTimes(0);
  } finally {
    harness.cleanup();
  }
});

test("workflow run deadline is enforced before inspection", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    await installWorkflow(harness);
    const response = await runInspectionWorkflow(harness, handle.handoffId, true, 1, 10);
    const body = (await response.json()) as {
      outcome?: string;
      runResult?: { available?: boolean; inspection?: WorktreeInspection | null };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.available).toBe(true);
    expect(body.runResult?.inspection).toBeNull();
  } finally {
    harness.cleanup();
  }
});
