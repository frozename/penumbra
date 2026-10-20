import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlannedStep, StepInvocation } from "./check-ci.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { parse } = requireFromCore("yaml") as { parse: (source: string) => unknown };

type CiStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};

type Workflow = { jobs: { check: { steps: CiStep[] } } };

async function implementation(): Promise<typeof import("./check-ci.js")> {
  expect(
    await Bun.file(join(import.meta.dir, "check-ci.ts")).exists(),
    "scripts/check-ci.ts must be implemented",
  ).toBe(true);
  return await import("./check-ci.js");
}

async function workflowSteps(): Promise<CiStep[]> {
  const workflow = parse(
    await Bun.file(new URL("../.github/workflows/check.yml", import.meta.url)).text(),
  ) as Workflow;
  return workflow.jobs.check.steps;
}

const ADVISORY_LINT = "lint (advisory - whole-repo burn-down tracker, see strict-lint ratchet)";
const EMBEDDER_STEP = "embedder model (pinned release asset, sha256-verified)";

describe("check:ci step census", () => {
  test("every check.yml step is classified (executed or skipped with a reason)", async () => {
    const { planWorkflow } = await implementation();
    const { steps, error } = planWorkflow(await workflowSteps());
    expect(error).toBeNull();
    expect(steps.length).toBeGreaterThan(0);
    for (const { plan } of steps) {
      expect(
        plan.classified,
        `step ${JSON.stringify(plan.name)} is not in the check:ci classification table`,
      ).toBe(true);
      if (plan.action === "skip") {
        expect(
          plan.reason !== null && plan.reason.length > 0,
          `skipped step ${JSON.stringify(plan.name)} must carry a written reason`,
        ).toBe(true);
      }
    }
  });

  test("the blocking gates execute in CI order starting at install, and the advisory lint is skipped", async () => {
    const { planWorkflow } = await implementation();
    const { steps } = planWorkflow(await workflowSteps());
    const plans = steps.map(({ plan }) => plan);
    const executed = plans.filter((plan) => plan.action === "execute").map((plan) => plan.name);
    expect(executed).toEqual([
      "install",
      EMBEDDER_STEP,
      "typecheck",
      "typecheck coverage ratchet (blocking: floors fall, never rise)",
      "console (blocking: unit + build)",
      "test (blocking: sharded per package)",
      "lint:strict (BLOCKING - ratcheted packages must stay at eslint --max-warnings=0)",
    ]);
    const advisory = plans.find((plan) => plan.name === ADVISORY_LINT);
    expect(advisory?.action).toBe("skip");
    expect(advisory?.reason).toContain("continue-on-error");
  });
});

describe("check:ci planner", () => {
  test("a check.yml fixture without an install step makes the planner fail", async () => {
    const { planWorkflow } = await implementation();
    const { steps, error } = planWorkflow([
      { uses: "actions/checkout@v4" },
      { name: "typecheck", run: "bun run typecheck" },
    ]);
    expect(error).not.toBeNull();
    expect(steps).toHaveLength(0);
  });

  test("an empty step list makes the planner fail", async () => {
    const { planWorkflow } = await implementation();
    const { steps, error } = planWorkflow([]);
    expect(error).not.toBeNull();
    expect(steps).toHaveLength(0);
  });

  test("an install step that cannot execute makes the planner fail", async () => {
    const { planWorkflow } = await implementation();
    const { error } = planWorkflow([
      { uses: "actions/checkout@v4" },
      { name: "install" },
      { name: "typecheck", run: "bun run typecheck" },
    ]);
    expect(error).not.toBeNull();
  });

  test("the plan's first executed step is the install command", async () => {
    const { planWorkflow } = await implementation();
    const { steps, error } = planWorkflow(await workflowSteps());
    expect(error).toBeNull();
    const executed = steps.filter(({ plan }) => plan.action === "execute");
    expect(executed.length).toBeGreaterThan(0);
    expect(executed[0]?.step.name).toBe("install");
    expect(executed[0]?.step.run).toBe("bun install --frozen-lockfile");
  });

  test("steps before install stay in the plan as classified skips", async () => {
    const { planWorkflow } = await implementation();
    const { steps, error } = planWorkflow(await workflowSteps());
    expect(error).toBeNull();
    const installIndex = steps.findIndex(({ step }) => step.name === "install");
    expect(installIndex).toBeGreaterThan(0);
    for (const { plan } of steps.slice(0, installIndex)) {
      expect(plan.action).toBe("skip");
      expect(plan.classified).toBe(true);
      expect(plan.reason).not.toBeNull();
    }
  });
});

describe("check:ci runner", () => {
  function executorReturning(
    exits: Record<string, number>,
    ran: string[],
  ): (invocation: { name: string }) => Promise<number> {
    return (invocation) => {
      ran.push(invocation.name);
      return Promise.resolve(exits[invocation.name] ?? 0);
    };
  }

  async function planAll(steps: CiStep[]): Promise<PlannedStep[]> {
    const { classifyStep } = await implementation();
    return steps.map((step) => ({ step, plan: classifyStep(step) }));
  }

  test("a failing step does not stop later blocking steps and the plan exits non-zero", async () => {
    const { runPlan } = await implementation();
    const ran: string[] = [];
    const { outcomes, exitCode } = await runPlan(
      await planAll([
        { name: "first", run: "exit 1" },
        { name: "second", run: "exit 0" },
        { name: ADVISORY_LINT, run: "exit 9" },
        { name: "fourth", run: "exit 0" },
      ]),
      {
        executor: executorReturning({ first: 1 }, ran),
        hostEnv: {},
      },
    );
    expect(ran).toEqual(["first", "second", "fourth"]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fail", "pass", "skipped", "pass"]);
    expect(exitCode).toBe(1);
  });

  test("all steps passing exits zero", async () => {
    const { runPlan } = await implementation();
    const { outcomes, exitCode } = await runPlan(
      await planAll([
        { name: "a", run: "true" },
        { name: "b", run: "true" },
      ]),
      { executor: executorReturning({}, []), hostEnv: {} },
    );
    expect(outcomes.every((outcome) => outcome.status === "pass")).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("an empty plan exits non-zero instead of reporting PASS", async () => {
    const { runPlan } = await implementation();
    const { outcomes, exitCode } = await runPlan([], {
      executor: executorReturning({}, []),
      hostEnv: {},
    });
    expect(outcomes).toHaveLength(0);
    expect(exitCode).toBe(1);
  });

  test("a plan with nothing to execute exits non-zero instead of reporting PASS", async () => {
    const { runPlan } = await implementation();
    const ran: string[] = [];
    const { outcomes, exitCode } = await runPlan(
      await planAll([{ name: ADVISORY_LINT, run: "exit 9" }]),
      { executor: executorReturning({}, ran), hostEnv: {} },
    );
    expect(ran).toHaveLength(0);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped"]);
    expect(exitCode).toBe(1);
  });

  test("an unclassified step is still executed (fail-closed toward running)", async () => {
    const { runPlan } = await implementation();
    const ran: string[] = [];
    const { outcomes, exitCode } = await runPlan(
      await planAll([{ name: "brand-new-ci-step", run: "true" }]),
      {
        executor: executorReturning({}, ran),
        hostEnv: {},
      },
    );
    expect(ran).toEqual(["brand-new-ci-step"]);
    expect(outcomes[0]?.status).toBe("pass");
    expect(exitCode).toBe(0);
  });
});

describe("check:ci environment", () => {
  test("CI=1 is exported, opt-in service gates are cleared, and the agy binary is neutralized", async () => {
    const { buildStepEnv, AGY_SENTINEL } = await implementation();
    const env = buildStepEnv({
      AGY_BINARY: "/real/agy/on/this/host",
      CI: "0",
      KEEP_ME: "yes",
      PENUMBRA_AGENTCHAT_SERVICE_TESTS: "1",
      PENUMBRA_DAEMON_SERVICE_TESTS: "1",
      PENUMBRA_E2E: "1",
      PENUMBRA_E2E_LLAMACTL: "1",
      PENUMBRA_RUN_OPENCODE_INTEGRATION: "1",
    });
    expect(env["CI"]).toBe("1");
    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["AGY_BINARY"]).toBe(AGY_SENTINEL);
    expect(await Bun.file(env["AGY_BINARY"] ?? "").exists()).toBe(false);
    for (const key of [
      "PENUMBRA_AGENTCHAT_SERVICE_TESTS",
      "PENUMBRA_DAEMON_SERVICE_TESTS",
      "PENUMBRA_E2E",
      "PENUMBRA_E2E_LLAMACTL",
      "PENUMBRA_RUN_OPENCODE_INTEGRATION",
    ]) {
      expect(env[key], `${key} must be cleared so host-only tests skip like on CI`).toBeUndefined();
    }
  });

  test("a step env GitHub expression resolves from the host env or is dropped", async () => {
    const { buildStepEnv } = await implementation();
    expect(
      buildStepEnv({ GH_TOKEN: "host-token" }, { GH_TOKEN: "${{ github.token }}" })["GH_TOKEN"],
    ).toBe("host-token");
    const env = buildStepEnv({}, { GH_TOKEN: "${{ github.token }}", NODE_OPTIONS: "x" });
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["NODE_OPTIONS"]).toBe("x");
  });
});

describe("check:ci embedder step", () => {
  test("runs the fetch with --from when a main-worktree local_cache is supplied", async () => {
    const { classifyStep, runPlan } = await implementation();
    const commands: string[] = [];
    await runPlan(
      [
        {
          step: { name: EMBEDDER_STEP, run: "bun scripts/fetch-embedder-model.ts" },
          plan: classifyStep({ name: EMBEDDER_STEP, run: "bun scripts/fetch-embedder-model.ts" }),
        },
      ],
      {
        executor: (invocation) => {
          commands.push(invocation.command);
          return Promise.resolve(0);
        },
        embedderSourceDir: "/main/local_cache",
        hostEnv: {},
      },
    );
    expect(commands).toEqual(["bun scripts/fetch-embedder-model.ts --from '/main/local_cache'"]);
  });

  test("runs the CI command unchanged without a local source", async () => {
    const { classifyStep, runPlan } = await implementation();
    const commands: string[] = [];
    await runPlan(
      [
        {
          step: { name: EMBEDDER_STEP, run: "bun scripts/fetch-embedder-model.ts" },
          plan: classifyStep({ name: EMBEDDER_STEP, run: "bun scripts/fetch-embedder-model.ts" }),
        },
      ],
      {
        executor: (invocation) => {
          commands.push(invocation.command);
          return Promise.resolve(0);
        },
        embedderSourceDir: null,
        hostEnv: {},
      },
    );
    expect(commands).toEqual(["bun scripts/fetch-embedder-model.ts"]);
  });
});

describe("check:ci install step dependency safety", () => {
  const INSTALL = { name: "install", run: "bun install --frozen-lockfile" };

  async function installPlan(extraSteps: CiStep[] = []): Promise<PlannedStep[]> {
    const { classifyStep } = await implementation();
    return [INSTALL, ...extraSteps].map((step) => ({ step, plan: classifyStep(step) }));
  }

  function recordingExecutor(
    ran: StepInvocation[],
    exits: Record<string, number> = {},
  ): (invocation: StepInvocation) => Promise<number> {
    return (invocation) => {
      ran.push(invocation);
      return Promise.resolve(exits[invocation.name] ?? 0);
    };
  }

  function realExecutor(ran: StepInvocation[]): (invocation: StepInvocation) => Promise<number> {
    return (invocation) => {
      ran.push(invocation);
      const proc = Bun.spawnSync({
        cmd: ["bash", "-c", invocation.command],
        cwd: invocation.cwd,
        env: invocation.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.resolve(proc.exitCode);
    };
  }

  function makeFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "check-ci-install-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    for (const pkg of ["a", "b"]) {
      mkdirSync(join(dir, "packages", pkg), { recursive: true });
      writeFileSync(
        join(dir, "packages", pkg, "package.json"),
        JSON.stringify({ name: `@fixture/${pkg}`, version: "1.0.0", private: true }),
      );
    }
    const install = Bun.spawnSync({
      cmd: ["bun", "install"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode, "fixture bun install must succeed").toBe(0);
    expect(existsSync(join(dir, "bun.lock"))).toBe(true);
    return dir;
  }

  test("a symlinked node_modules never runs a writing install; drift is checked with --dry-run", async () => {
    const { runPlan } = await implementation();
    const ran: StepInvocation[] = [];
    const { outcomes, exitCode } = await runPlan(
      await installPlan([{ name: "typecheck", run: "bun run typecheck" }]),
      {
        executor: recordingExecutor(ran),
        hostEnv: {},
        cwd: "/fixture",
        detectSymlinkedNodeModules: () => ["node_modules"],
      },
    );
    expect(exitCode).toBe(0);
    expect(ran.map((invocation) => invocation.name)).toEqual(["install", "typecheck"]);
    const install = ran.find((invocation) => invocation.name === "install");
    expect(install?.command).toBe("bun install --frozen-lockfile --dry-run");
    for (const invocation of ran) {
      expect(
        !invocation.command.includes("bun install") || invocation.command.includes("--dry-run"),
        `command must not write to node_modules: ${invocation.command}`,
      ).toBe(true);
    }
    const installOutcome = outcomes.find((outcome) => outcome.name === "install");
    expect(installOutcome?.status).toBe("pass");
    expect(installOutcome?.reason ?? "").toContain("dry-run");
  });

  test("a non-symlinked tree runs the frozen install unchanged", async () => {
    const { runPlan } = await implementation();
    const ran: StepInvocation[] = [];
    await runPlan(await installPlan(), {
      executor: recordingExecutor(ran),
      hostEnv: {},
      cwd: "/fixture",
      detectSymlinkedNodeModules: () => [],
    });
    expect(ran.find((invocation) => invocation.name === "install")?.command).toBe(
      "bun install --frozen-lockfile",
    );
  });

  test("the probe reports symlinked node_modules at the root and under workspace dirs", async () => {
    const { detectSymlinkedNodeModules } = await implementation();
    const dir = mkdtempSync(join(tmpdir(), "check-ci-probe-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*", "packages/integrations/*"] }),
    );
    mkdirSync(join(dir, "packages", "a", "node_modules"), { recursive: true });
    mkdirSync(join(dir, "packages", "b"), { recursive: true });
    mkdirSync(join(dir, "packages", "integrations", "x"), { recursive: true });
    mkdirSync(join(dir, "targets", "b"), { recursive: true });
    mkdirSync(join(dir, "targets", "root"), { recursive: true });
    mkdirSync(join(dir, "targets", "x"), { recursive: true });
    symlinkSync(join(dir, "targets", "b"), join(dir, "packages", "b", "node_modules"), "dir");
    symlinkSync(
      join(dir, "targets", "x"),
      join(dir, "packages", "integrations", "x", "node_modules"),
      "dir",
    );
    symlinkSync(join(dir, "targets", "root"), join(dir, "node_modules"), "dir");
    expect(detectSymlinkedNodeModules(dir)).toEqual([
      "node_modules",
      "packages/b/node_modules",
      "packages/integrations/x/node_modules",
    ]);
  });

  test("the probe reports nothing when node_modules dirs are real or absent", async () => {
    const { detectSymlinkedNodeModules } = await implementation();
    const dir = mkdtempSync(join(tmpdir(), "check-ci-probe-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    mkdirSync(join(dir, "packages", "a", "node_modules"), { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    expect(detectSymlinkedNodeModules(dir)).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), "check-ci-probe-"));
    expect(detectSymlinkedNodeModules(empty)).toEqual([]);
  });

  test("a lockfile-drift fixture fails the install step and writes nothing", async () => {
    const { runPlan } = await implementation();
    const dir = makeFixture();
    const lockBefore = readFileSync(join(dir, "bun.lock"));
    mkdirSync(join(dir, "packages", "c"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "c", "package.json"),
      JSON.stringify({ name: "@fixture/c", version: "1.0.0", private: true }),
    );
    const ran: StepInvocation[] = [];
    const { outcomes, exitCode } = await runPlan(await installPlan(), {
      executor: realExecutor(ran),
      hostEnv: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      detectSymlinkedNodeModules: () => ["node_modules"],
    });
    expect(ran[0]?.command).toBe("bun install --frozen-lockfile --dry-run");
    expect(outcomes[0]?.status).toBe("fail");
    expect(exitCode).toBe(1);
    expect(readFileSync(join(dir, "bun.lock"))).toEqual(lockBefore);
    expect(existsSync(join(dir, "packages", "c", "node_modules"))).toBe(false);
  });

  test("a consistent fixture passes the dry-run install check", async () => {
    const { runPlan } = await implementation();
    const dir = makeFixture();
    const ran: StepInvocation[] = [];
    const { outcomes, exitCode } = await runPlan(await installPlan(), {
      executor: realExecutor(ran),
      hostEnv: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      detectSymlinkedNodeModules: () => ["node_modules"],
    });
    expect(ran[0]?.command).toBe("bun install --frozen-lockfile --dry-run");
    expect(outcomes[0]?.status).toBe("pass");
    expect(outcomes[0]?.reason ?? "").toContain("dry-run");
    expect(exitCode).toBe(0);
  });
});

describe("check:ci failure details", () => {
  async function planSteps(steps: CiStep[]): Promise<PlannedStep[]> {
    const { classifyStep } = await implementation();
    return steps.map((step) => ({ step, plan: classifyStep(step) }));
  }

  test("a failing step's last ~60 lines appear in a section after the summary", async () => {
    const { renderRunReport, runPlan } = await implementation();
    const executor = (invocation: StepInvocation): Promise<number> => {
      for (let i = 1; i <= 80; i++) {
        invocation.onOutput(`${invocation.name} line ${String(i)}\n`);
      }
      return Promise.resolve(invocation.name === "broken" ? 3 : 0);
    };
    const { outcomes, exitCode } = await runPlan(
      await planSteps([
        { name: "broken", run: "exit 3" },
        { name: "fine", run: "true" },
      ]),
      { executor, hostEnv: {} },
    );
    const report = renderRunReport(outcomes, exitCode);
    const summaryIndex = report.indexOf("== check:ci summary ==");
    const detailsIndex = report.indexOf("== failure details ==");
    const lastLineIndex = report.indexOf("broken line 80");
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(detailsIndex).toBeGreaterThan(summaryIndex);
    expect(lastLineIndex).toBeGreaterThan(detailsIndex);
    expect(report).toContain("broken line 21\n");
    expect(report).not.toContain("broken line 20\n");
    expect(report).not.toContain("fine line");
    expect(report).toContain("--- broken");
  });

  test("an all-pass run emits no failure details section", async () => {
    const { renderRunReport, runPlan } = await implementation();
    const executor = (invocation: StepInvocation): Promise<number> => {
      invocation.onOutput("some output\n");
      return Promise.resolve(0);
    };
    const { outcomes, exitCode } = await runPlan(await planSteps([{ name: "ok", run: "true" }]), {
      executor,
      hostEnv: {},
    });
    expect(renderRunReport(outcomes, exitCode)).not.toContain("== failure details ==");
  });

  test("a failing step with no captured output still gets a details entry", async () => {
    const { renderRunReport, runPlan } = await implementation();
    const { outcomes, exitCode } = await runPlan(
      await planSteps([{ name: "silent-fail", run: "exit 1" }]),
      { executor: () => Promise.resolve(1), hostEnv: {} },
    );
    const report = renderRunReport(outcomes, exitCode);
    expect(report).toContain("== failure details ==");
    expect(report).toContain("silent-fail");
  });
});
