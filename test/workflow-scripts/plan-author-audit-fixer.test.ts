import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPlanValidate } from "../../packages/cli/src/commands/plan.js";
import { type AgentStub, runScript } from "./harness.js";

// The fixer ships as a string array the workflow hands to an agent to write and
// run. These tests play that agent: they cut the program out of the prompt
// byte for byte, execute it on fixture phase files, and report the real byte
// count, so the script's own FIXER_BYTES receipt is checked as well.
const SCRIPT = ".claude/workflows/plan-author-audit.js";
const SEATS = ["seat-alpha", "seat-beta"];
const HOME_PROJECT = "penumbra";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface AssembleRun {
  result: Record<string, unknown> | undefined;
  agentCalls: number;
  error?: unknown;
  plan: string;
  planPath: string;
  repo: string;
  report: Record<string, unknown> | null;
}

function taskBlock(id: string, expected: string): string {
  return [
    `### Task ${id}: Add the thing`,
    "",
    "```yaml meta",
    `id: "${id}"`,
    "files:",
    `  - src/thing-${id}.ts`,
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    `preferred_agent: ${SEATS[0]}`,
    `fallback_agent: ${SEATS[1]}`,
    "task_size: small",
    "risk_class: paste-ready",
    "```",
    "",
    "- [ ] **Step 1:** write the failing test.",
    "",
    expected,
  ].join("\n");
}

async function runAssembler(
  phaseBody: string,
  extraArgs: Record<string, unknown> = {},
): Promise<AssembleRun> {
  const repo = mkdtempSync(join(tmpdir(), "plan-author-audit-repo-"));
  dirs.push(repo);
  const runDir = join(repo, "run");
  const planPath = join(repo, "docs", "plans", "demo-plan.md");
  mkdirSync(join(runDir, "phases"), { recursive: true });
  writeFileSync(join(runDir, "phases", "phase-1.md"), phaseBody);

  let report: Record<string, unknown> | null = null;
  const agentStub: AgentStub = async (prompt, options) => {
    const label = String(options?.label ?? "");
    if (label === "plan-context") {
      return {
        exit_code: 0,
        command: "stub",
        constraint_markdown: "(stub constraints)",
        seats: SEATS,
        phase_header_regex_source: "^## Phase \\d+(?: — |: )",
        phase_header_separator: " — ",
        gate_commands: [],
      };
    }
    if (label.startsWith("author:phase-")) {
      return {
        phase_no: 1,
        path: join(runDir, "phases", "phase-1.md"),
        bytes: Buffer.byteLength(phaseBody),
        task_ids: ["1.1"],
        seats_used: SEATS,
        evidence_claim_ids_used: [],
      };
    }
    if (label === "assemble+fix") {
      const begin = "----- BEGIN PROGRAM -----\n";
      const start = prompt.indexOf(begin) + begin.length;
      const end = prompt.lastIndexOf("\n----- END PROGRAM -----");
      const fixerPath = join(runDir, "plan-fixer.generated.cjs");
      writeFileSync(fixerPath, prompt.slice(start, end));
      const run = Bun.spawnSync([process.execPath, fixerPath], { cwd: repo });
      const stdout = run.stdout.toString();
      report = run.exitCode === 0 ? (JSON.parse(stdout) as Record<string, unknown>) : null;
      return {
        fixer_bytes_written: statSync(fixerPath).size,
        exit_code: run.exitCode,
        report_json: run.exitCode === 0 ? stdout : run.stderr.toString(),
      };
    }
    if (label === "audit") {
      return { blocking: [], advisory: [], fabricated_evidence: [], verdict: "dispatch_ready" };
    }
    if (label === "validate") {
      return { exit_code: 0, command: "stub", stderr_lines: [] };
    }
    throw new Error(`unexpected agent call: ${label}`);
  };

  const { result, agentCalls, error } = await runScript(
    SCRIPT,
    {
      phases: [{ n: 1, title: "Foundation", brief: "", claim_ids: [] }],
      evidenceDir: join(repo, "evidence"),
      repo,
      runDir,
      planPath,
      homeProject: HOME_PROJECT,
      ...extraArgs,
    },
    agentStub,
  );
  let plan = "";
  try {
    plan = readFileSync(planPath, "utf8");
  } catch {
    plan = "";
  }
  return {
    result: result as Record<string, unknown> | undefined,
    agentCalls,
    error,
    plan,
    planPath,
    repo,
    report,
  };
}

describe("plan-author-audit assembler front matter", () => {
  test("the assembled plan opens with the header plan validate requires", async () => {
    const run = await runAssembler(taskBlock("1.1", "Expected: baseline + 1 pass / 0 fail."), {
      preamble: "# Demo plan\n\n**Goal:** prove the header.",
    });

    expect(run.error).toBeUndefined();
    expect(run.result?.ok).toBe(true);
    expect(
      run.plan.startsWith("---\nplan_id: demo-plan\nhome_project: penumbra\n---\n\n# Demo plan\n"),
    ).toBe(true);

    const errs: string[] = [];
    const code = await runPlanValidate({
      path: run.planPath,
      repoRoot: run.repo,
      knownAgents: new Set(SEATS),
      projectRegistry: { has: (id) => id === HOME_PROJECT },
      out: () => {
        /* discard */
      },
      err: (line) => errs.push(line),
    });
    expect(errs).toEqual([]);
    expect(code).toBe(0);
  });

  test("an explicit planId names the header", async () => {
    const run = await runAssembler(taskBlock("1.1", "Expected: baseline + 1 pass."), {
      planId: "2026-10-19-demo",
    });

    expect(run.error).toBeUndefined();
    expect(
      run.plan.startsWith("---\nplan_id: 2026-10-19-demo\nhome_project: penumbra\n---\n"),
    ).toBe(true);
  });

  test("fails closed before any agent runs without a usable homeProject", async () => {
    for (const homeProject of [undefined, "Penumbra", "../x"]) {
      const run = await runAssembler(taskBlock("1.1", "Expected: baseline + 1 pass."), {
        homeProject,
      });
      expect(run.error).toBeUndefined();
      expect(run.result?.ok).toBe(false);
      expect(String(run.result?.error)).toStartWith("no_home_project:");
      expect(run.agentCalls).toBe(0);
    }
  });

  test("refuses a preamble that carries its own front matter", async () => {
    const run = await runAssembler(taskBlock("1.1", "Expected: baseline + 1 pass."), {
      preamble: "---\nplan_id: other\nhome_project: penumbra\n---\n\n# Demo",
    });

    expect(run.error).toBeUndefined();
    expect(run.result?.ok).toBe(false);
    expect(String(run.result?.error)).toStartWith("preamble_has_front_matter:");
    expect(run.agentCalls).toBe(0);
  });
});
