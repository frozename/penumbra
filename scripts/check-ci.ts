#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export type CiStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};

export type CiWorkflow = { jobs: { check: { steps: CiStep[] } } };

export type StepPlan = {
  name: string;
  action: "execute" | "skip";
  classified: boolean;
  reason: string | null;
};

export type StepOutcome = {
  name: string;
  status: "pass" | "fail" | "skipped";
  exitCode: number | null;
  reason: string | null;
  durationMs: number;
  outputTail: string;
};

export type StepInvocation = {
  name: string;
  command: string;
  env: Record<string, string>;
  cwd: string;
  onOutput: (chunk: string) => void;
};

export type StepExecutor = (invocation: StepInvocation) => Promise<number>;

export const ROOT = resolve(import.meta.dir, "..");

// Per-step captured output is capped so a chatty shard cannot grow memory
// without bound; the failure-details section only ever prints the tail.
const STEP_OUTPUT_BUFFER_CHARS = 256 * 1024;
export const FAILURE_DETAIL_LINES = 60;

const INSTALL_STEP = "install";
export const EMBEDDER_STEP = "embedder model (pinned release asset, sha256-verified)";

// Points the agy-acp-shim detection (AGY_BINARY ?? Bun.which("agy")) at a path
// that never exists, so the "requires local agy binary" tests skip exactly the
// way they do on the CI runner where no agy is installed.
export const AGY_SENTINEL = join(ROOT, ".check-ci", "agy-not-installed");

// Steps that must not run on a host checkout, each with its reason. Every
// other step with a `run:` executes — including steps absent from
// EXECUTED_STEPS, so a new CI step can never be silently skipped.
const SKIPPED_STEPS: Record<string, string> = {
  "install ripgrep": "installs a system package via apt; the host already provides rg",
  "lint (advisory - whole-repo burn-down tracker, see strict-lint ratchet)":
    "advisory in CI (continue-on-error: true); the blocking gate is lint:strict",
};

const EXECUTED_STEPS: readonly string[] = [
  INSTALL_STEP,
  EMBEDDER_STEP,
  "typecheck",
  "typecheck coverage ratchet (blocking: floors fall, never rise)",
  "console (blocking: unit + build)",
  "test (blocking: sharded per package)",
  "lint:strict (BLOCKING - ratcheted packages must stay at eslint --max-warnings=0)",
];

const EXECUTED_SET = new Set<string>(EXECUTED_STEPS);

// Opt-in test gates that CI never sets. Cleared from the child environment so
// host values cannot flip tests on that the runner would skip.
const HOST_ONLY_ENV_KEYS = new Set<string>([
  "PENUMBRA_AGENTCHAT_SERVICE_TESTS",
  "PENUMBRA_DAEMON_SERVICE_TESTS",
  "PENUMBRA_E2E",
  "PENUMBRA_E2E_LLAMACTL",
  "PENUMBRA_E2E_LLAMACTL_MANIFEST",
  "PENUMBRA_RUN_OPENCODE_INTEGRATION",
]);

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { parse: parseYaml } = requireFromCore("yaml") as { parse: (source: string) => unknown };

export type PlannedStep = {
  step: CiStep;
  plan: StepPlan;
};

// Steps before `install` are checkout/toolchain provisioning that the host
// checkout already satisfies; they stay in the plan as classified skips so the
// summary still accounts for them.
const PRE_INSTALL_REASON = "runs before install; provided by the host checkout and toolchain";

export function planWorkflow(steps: CiStep[]): { steps: PlannedStep[]; error: string | null } {
  const installIndex = steps.findIndex((step) => step.name === INSTALL_STEP);
  if (installIndex < 0) {
    return {
      steps: [],
      error: `check.yml has no step named '${INSTALL_STEP}'; refusing to replay an unanchored plan`,
    };
  }
  const planned = steps.map((step, index): PlannedStep => {
    if (index < installIndex) {
      return {
        step,
        plan: {
          name: step.name ?? "(unnamed step)",
          action: "skip",
          classified: true,
          reason: PRE_INSTALL_REASON,
        },
      };
    }
    return { step, plan: classifyStep(step) };
  });
  if (planned[installIndex]?.plan.action !== "execute") {
    return {
      steps: planned,
      error: `check.yml step '${INSTALL_STEP}' is not executable; refusing to replay without it`,
    };
  }
  return { steps: planned, error: null };
}

export function classifyStep(step: CiStep): StepPlan {
  const name = step.name ?? "(unnamed step)";
  const skipReason = SKIPPED_STEPS[name];
  if (skipReason !== undefined) {
    return { name, action: "skip", classified: true, reason: skipReason };
  }
  if (typeof step.run !== "string" || step.run.trim().length === 0) {
    return {
      name,
      action: "skip",
      classified: EXECUTED_SET.has(name),
      reason: "no run: command (uses:/metadata step)",
    };
  }
  return { name, action: "execute", classified: EXECUTED_SET.has(name), reason: null };
}

function workspacePatterns(cwd: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : ((workspaces as { packages?: unknown } | undefined)?.packages ?? []);
  if (!Array.isArray(patterns)) return [];
  return patterns.filter(
    (pattern): pattern is string => typeof pattern === "string" && !pattern.startsWith("!"),
  );
}

// Fleet symlink_mirror worktrees point node_modules (root and per-workspace)
// into the main checkout, so a real `bun install` would write through the
// links and mutate another checkout's dependencies. Returns the relative paths
// of every node_modules dir that is a symlink; empty means installs are safe.
export function detectSymlinkedNodeModules(cwd: string): string[] {
  const candidates = new Set<string>(["node_modules"]);
  for (const pattern of workspacePatterns(cwd)) {
    for (const match of new Bun.Glob(`${pattern}/node_modules`).scanSync({
      cwd,
      onlyFiles: false,
    })) {
      candidates.add(match);
    }
  }
  const linked: string[] = [];
  for (const rel of candidates) {
    try {
      if (lstatSync(join(cwd, rel)).isSymbolicLink()) linked.push(rel);
    } catch {
      // missing or unreadable entries are not symlinks
    }
  }
  return linked.sort();
}

export function buildStepEnv(
  hostEnv: NodeJS.ProcessEnv,
  stepEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined || HOST_ONLY_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  env["CI"] = "1";
  env["AGY_BINARY"] = AGY_SENTINEL;
  for (const [key, value] of Object.entries(stepEnv ?? {})) {
    if (value.includes("${{")) {
      const host = hostEnv[key];
      if (host !== undefined) env[key] = host;
      continue;
    }
    env[key] = value;
  }
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stepCommand(step: CiStep, embedderSourceDir: string | null): string {
  const run = step.run ?? "";
  if (step.name === EMBEDDER_STEP && embedderSourceDir !== null) {
    return `${run} --from ${shellQuote(embedderSourceDir)}`;
  }
  return run;
}

export async function runPlan(
  steps: PlannedStep[],
  opts: {
    executor: StepExecutor;
    hostEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    embedderSourceDir?: string | null;
    detectSymlinkedNodeModules?: (cwd: string) => string[];
    onStep?: (event: { plan: StepPlan; command: string }) => void;
    onOutcome?: (outcome: StepOutcome) => void;
  },
): Promise<{ outcomes: StepOutcome[]; exitCode: number }> {
  const outcomes: StepOutcome[] = [];
  const cwd = opts.cwd ?? ROOT;
  const hostEnv = opts.hostEnv ?? process.env;
  const embedderSourceDir = opts.embedderSourceDir ?? null;
  const detectSymlinks = opts.detectSymlinkedNodeModules ?? detectSymlinkedNodeModules;

  for (const { step, plan } of steps) {
    if (plan.action === "skip") {
      const outcome: StepOutcome = {
        name: plan.name,
        status: "skipped",
        exitCode: null,
        reason: plan.reason,
        durationMs: 0,
        outputTail: "",
      };
      outcomes.push(outcome);
      opts.onOutcome?.(outcome);
      continue;
    }
    let command = stepCommand(step, embedderSourceDir);
    let reason: string | null = null;
    // `--dry-run` keeps the frozen-lockfile drift check but writes nothing, so
    // it cannot leak through a symlinked node_modules into another checkout.
    if (step.name === INSTALL_STEP) {
      const linked = detectSymlinks(cwd);
      if (linked.length > 0) {
        command = `${command} --dry-run`;
        reason = `node_modules is a symlink (${linked.join(", ")}); ran the frozen-lockfile drift check with --dry-run instead of installing`;
      }
    }
    opts.onStep?.({ plan, command });
    let outputTail = "";
    const started = Date.now();
    const exitCode = await opts.executor({
      name: plan.name,
      command,
      env: buildStepEnv(hostEnv, step.env),
      cwd,
      onOutput: (chunk) => {
        outputTail += chunk;
        if (outputTail.length > STEP_OUTPUT_BUFFER_CHARS) {
          outputTail = outputTail.slice(-STEP_OUTPUT_BUFFER_CHARS);
        }
      },
    });
    const outcome: StepOutcome = {
      name: plan.name,
      status: exitCode === 0 ? "pass" : "fail",
      exitCode,
      reason,
      durationMs: Date.now() - started,
      outputTail,
    };
    outcomes.push(outcome);
    opts.onOutcome?.(outcome);
  }

  // A plan that executes nothing verifies nothing; it must not report green.
  const executed = steps.some(({ plan }) => plan.action === "execute");
  const failed = outcomes.some((outcome) => outcome.status === "fail");
  return { outcomes, exitCode: executed && !failed ? 0 : 1 };
}

const bashExecutor: StepExecutor = async ({ command, env, cwd, onOutput }) => {
  const child = spawn("bash", ["-euo", "pipefail", "-c", command], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    onOutput(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    onOutput(chunk.toString());
  });
  return await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise(code ?? 1);
    });
  });
};

async function loadCiSteps(): Promise<CiStep[]> {
  const workflow = parseYaml(
    await Bun.file(new URL("../.github/workflows/check.yml", import.meta.url)).text(),
  ) as CiWorkflow;
  return workflow.jobs.check.steps;
}

function mainWorktreeRoot(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const commonDir = proc.stdout.toString().trim();
    return commonDir.length > 0 ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

function formatOutcome(outcome: StepOutcome): string {
  if (outcome.status === "skipped") {
    return `SKIPPED ${outcome.name} — ${outcome.reason ?? "no reason"}`;
  }
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  const line = `${outcome.status === "pass" ? "PASS" : "FAIL"}    ${outcome.name} (exit ${String(outcome.exitCode ?? -1)}, ${seconds}s)`;
  return outcome.reason === null ? line : `${line} — ${outcome.reason}`;
}

function tailLines(text: string, count: number): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count);
}

// The summary sits at the tail of a long log; on failure the last thing a
// reader sees must be the actual failing output, not lint noise. Every failed
// step contributes its last FAILURE_DETAIL_LINES lines here.
export function formatFailureDetails(outcomes: StepOutcome[]): string {
  const failures = outcomes.filter((outcome) => outcome.status === "fail");
  if (failures.length === 0) return "";
  const parts = ["", "== failure details =="];
  for (const failure of failures) {
    const tail = tailLines(failure.outputTail, FAILURE_DETAIL_LINES);
    parts.push("", `--- ${failure.name} (last ${String(FAILURE_DETAIL_LINES)} lines) ---`);
    parts.push(tail.length > 0 ? tail.join("\n") : "(no output captured)");
  }
  return `${parts.join("\n")}\n`;
}

export function renderRunReport(outcomes: StepOutcome[], exitCode: number): string {
  const lines = ["", "== check:ci summary =="];
  for (const outcome of outcomes) {
    lines.push(formatOutcome(outcome));
  }
  const failed = outcomes.filter((outcome) => outcome.status === "fail").length;
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped").length;
  const passed = outcomes.filter((outcome) => outcome.status === "pass").length;
  lines.push(
    `check:ci: ${exitCode === 0 ? "PASS" : "FAIL"} (${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped)`,
  );
  return `${lines.join("\n")}\n${formatFailureDetails(outcomes)}`;
}

async function main(): Promise<number> {
  const { steps, error } = planWorkflow(await loadCiSteps());
  const mainRoot = mainWorktreeRoot(ROOT);
  const cacheDir = mainRoot === null ? null : join(mainRoot, "local_cache");
  const embedderSourceDir = cacheDir !== null && existsSync(cacheDir) ? cacheDir : null;

  process.stdout.write("check:ci — replaying .github/workflows/check.yml blocking steps\n");
  if (error !== null) {
    process.stdout.write(`check:ci: ${error}\n`);
    return 1;
  }
  if (embedderSourceDir !== null) {
    process.stdout.write(`embedder model will copy from ${embedderSourceDir}\n`);
  }

  const { outcomes, exitCode } = await runPlan(steps, {
    executor: bashExecutor,
    embedderSourceDir,
    onStep: ({ plan, command }) => {
      const flag = plan.classified ? "" : " [UNCLASSIFIED — executing, then classify it]";
      process.stdout.write(`\n==> ${plan.name}${flag}\n$ ${command}\n`);
    },
    onOutcome: (outcome) => {
      process.stdout.write(`${formatOutcome(outcome)}\n`);
    },
  });

  process.stdout.write(renderRunReport(outcomes, exitCode));
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await main();
}
