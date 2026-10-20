import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPlanValidate } from "../../packages/cli/src/commands/plan.js";
import { parsePlanMeta } from "../../packages/workflows/src/plan-meta/parser.js";
import { type AgentStub, runScript } from "./harness.js";

// Plays every agent in plan-author-audit: the authors write real phase files,
// the fixer program is cut out of its prompt and run, so a run reaches the end
// and the assembled plan can be validated.
const SCRIPT = ".claude/workflows/plan-author-audit.js";
const SEATS = ["seat-alpha", "seat-beta"];
const BEGIN = "<!-- BEGIN EXPORTED CONTRACTS -->";
const END = "<!-- END EXPORTED CONTRACTS -->";
const FOUNDATION_CONTRACT = [
  "- Modules: `src/store.ts` exports `openStore`",
  "- Function signatures: `openStore(path: string): Store`",
  "- Ruled out: `better-sqlite3`; use `bun:sqlite`",
].join("\n");
const CONTRACT_SECTION = ["### Exported contracts", "", BEGIN, FOUNDATION_CONTRACT, END].join("\n");
const OPERATOR_CONTRACTS = "Every store goes through `openStore`; never add an ORM.";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function taskBlock(n: number): string {
  return [
    `### Task ${n}.1: Add the thing`,
    "",
    "```yaml meta",
    `id: "${n}.1"`,
    "files:",
    `  - src/thing-${n}.ts`,
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
    "Expected: baseline + 1 pass / 0 fail.",
  ].join("\n");
}

// What `sed -n '/BEGIN/,/END/p'` prints for the file the author wrote.
function readBackSection(body: string): string {
  const lines = body.split("\n");
  const begin = lines.indexOf(BEGIN);
  if (begin < 0) return "";
  const end = lines.indexOf(END, begin);
  return lines.slice(begin, end < 0 ? undefined : end + 1).join("\n");
}

interface PlanRun {
  result: Record<string, unknown> | undefined;
  agentCalls: number;
  error?: unknown;
  authorPrompts: Map<number, string>;
  authorSchemas: Map<number, Record<string, unknown> | undefined>;
  events: string[];
  plan: string;
  planPath: string;
  repo: string;
}

async function runPlan(
  phaseNos: number[],
  opts: {
    args?: Record<string, unknown>;
    tails?: Record<number, string>;
    failing?: number[];
  } = {},
): Promise<PlanRun> {
  const repo = mkdtempSync(join(tmpdir(), "plan-author-contracts-repo-"));
  dirs.push(repo);
  const runDir = join(repo, "run");
  const planPath = join(repo, "docs", "plans", "demo-plan.md");
  mkdirSync(join(runDir, "phases"), { recursive: true });

  const authorPrompts = new Map<number, string>();
  const authorSchemas = new Map<number, Record<string, unknown> | undefined>();
  const events: string[] = [];

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
    const author = /^author:phase-(\d+)$/.exec(label);
    if (author) {
      const n = Number(author[1]);
      const schema = options?.schema as { properties?: Record<string, unknown> } | undefined;
      authorPrompts.set(n, prompt);
      authorSchemas.set(n, schema);
      events.push(`start:${n}`);
      await Bun.sleep(5);
      events.push(`end:${n}`);
      if (opts.failing?.includes(n)) throw new Error(`author ${n} died`);
      const body = [taskBlock(n), opts.tails?.[n] ?? ""].join("\n\n").trimEnd() + "\n";
      const path = join(runDir, "phases", `phase-${n}.md`);
      writeFileSync(path, body);
      return {
        phase_no: n,
        path,
        bytes: Buffer.byteLength(body),
        task_ids: [`${n}.1`],
        seats_used: SEATS,
        evidence_claim_ids_used: [],
        ...(schema?.properties?.exported_contracts
          ? { exported_contracts: readBackSection(body) }
          : {}),
      };
    }
    if (label === "assemble+fix") {
      const begin = "----- BEGIN PROGRAM -----\n";
      const start = prompt.indexOf(begin) + begin.length;
      const end = prompt.lastIndexOf("\n----- END PROGRAM -----");
      const fixerPath = join(runDir, "plan-fixer.generated.cjs");
      writeFileSync(fixerPath, prompt.slice(start, end));
      const run = Bun.spawnSync([process.execPath, fixerPath], { cwd: repo });
      return {
        fixer_bytes_written: statSync(fixerPath).size,
        exit_code: run.exitCode,
        report_json: run.exitCode === 0 ? run.stdout.toString() : run.stderr.toString(),
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
      phases: phaseNos.map((n) => ({ n, title: `Phase ${n} work`, brief: "", claim_ids: [] })),
      evidenceDir: join(repo, "evidence"),
      repo,
      runDir,
      planPath,
      homeProject: "penumbra",
      ...opts.args,
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
    authorPrompts,
    authorSchemas,
    events,
    plan,
    planPath,
    repo,
  };
}

describe("plan-author-audit foundation-first authoring", () => {
  test("authors the foundation phase alone, then the rest together with its contracts", async () => {
    const run = await runPlan([1, 2, 3], { tails: { 1: CONTRACT_SECTION } });

    expect(run.error).toBeUndefined();
    expect(run.result?.ok).toBe(true);
    expect(run.events.slice(0, 2)).toEqual(["start:1", "end:1"]);
    expect(run.events.slice(2, 4).sort()).toEqual(["start:2", "start:3"]);

    const foundationPrompt = run.authorPrompts.get(1)!;
    expect(foundationPrompt).toContain(BEGIN);
    expect(foundationPrompt).toContain(END);
    expect(run.authorSchemas.get(1)?.required).toContain("exported_contracts");

    for (const n of [2, 3]) {
      const prompt = run.authorPrompts.get(n)!;
      expect(prompt).toContain(FOUNDATION_CONTRACT);
      expect(prompt).not.toContain(BEGIN);
      expect(run.authorSchemas.get(n)?.required).not.toContain("exported_contracts");
    }
    expect(run.result?.contracts).toEqual({
      operator_chars: 0,
      foundation_phase: 1,
      foundation_chars: FOUNDATION_CONTRACT.length,
      injected_into: [2, 3],
      skipped: null,
    });
  });

  test("the foundation's contract section stays in the plan but outside every task", async () => {
    const run = await runPlan([1, 2], { tails: { 1: CONTRACT_SECTION } });

    expect(run.result?.ok).toBe(true);
    expect(run.plan).toContain(CONTRACT_SECTION);
    expect(run.plan.indexOf(CONTRACT_SECTION)).toBeLessThan(run.plan.indexOf("## Phase 2"));
    const parsed = parsePlanMeta(run.plan);
    expect(parsed.tasks.map((t) => t.id)).toEqual(["1.1", "2.1"]);
    for (const t of parsed.tasks) expect(t.body ?? "").not.toContain("openStore");

    const errs: string[] = [];
    const code = await runPlanValidate({
      path: run.planPath,
      repoRoot: run.repo,
      knownAgents: new Set(SEATS),
      projectRegistry: { has: (id) => id === "penumbra" },
      out: () => {
        /* discard */
      },
      err: (line) => errs.push(line),
    });
    expect(errs).toEqual([]);
    expect(code).toBe(0);
  });

  test("the lowest-numbered phase is the foundation, whatever order phases arrive in", async () => {
    const run = await runPlan([7, 5, 6], { tails: { 5: CONTRACT_SECTION } });

    expect(run.events.slice(0, 2)).toEqual(["start:5", "end:5"]);
    expect(run.authorPrompts.get(6)).toContain(FOUNDATION_CONTRACT);
    expect(run.authorPrompts.get(7)).toContain(FOUNDATION_CONTRACT);
    expect((run.result?.contracts as { injected_into: number[] }).injected_into).toEqual([6, 7]);
  });

  test("a single-phase plan is authored as before, with no contract to export", async () => {
    const run = await runPlan([1]);

    expect(run.result?.ok).toBe(true);
    expect(run.authorPrompts.get(1)).not.toContain(BEGIN);
    expect(run.authorSchemas.get(1)?.required).not.toContain("exported_contracts");
    expect(run.result?.contracts).toEqual({
      operator_chars: 0,
      foundation_phase: null,
      foundation_chars: 0,
      injected_into: [],
      skipped: null,
    });
  });

  test("foundationFirst: false authors every phase in one parallel batch", async () => {
    const run = await runPlan([1, 2, 3], {
      args: { foundationFirst: false },
      tails: { 1: CONTRACT_SECTION },
    });

    expect(run.result?.ok).toBe(true);
    expect(run.events.slice(0, 3).sort()).toEqual(["start:1", "start:2", "start:3"]);
    for (const n of [1, 2, 3]) {
      expect(run.authorPrompts.get(n)).not.toContain(BEGIN);
      expect(run.authorPrompts.get(n)).not.toContain(FOUNDATION_CONTRACT);
    }
    expect((run.result?.contracts as { foundation_phase: unknown }).foundation_phase).toBeNull();
  });

  describe("a foundation that exports no usable contract is recorded, not fatal", () => {
    const cases: Array<[string, Record<number, string>, string]> = [
      ["no section", {}, "no " + BEGIN],
      ["an empty section", { 1: ["### Exported contracts", "", BEGIN, END].join("\n") }, "empty"],
      [
        "an unterminated section",
        { 1: ["### Exported contracts", "", BEGIN, "- x"].join("\n") },
        "no " + END,
      ],
    ];
    for (const [name, tails, reason] of cases) {
      test(name, async () => {
        const run = await runPlan([1, 2, 3], { tails });

        expect(run.error).toBeUndefined();
        expect(run.result?.ok).toBe(true);
        expect([...run.authorPrompts.keys()].sort()).toEqual([1, 2, 3]);
        expect(run.authorPrompts.get(2)).not.toContain("Foundation contracts");
        const contracts = run.result?.contracts as {
          injected_into: number[];
          skipped: { phase: number; reason: string } | null;
        };
        expect(contracts.injected_into).toEqual([]);
        expect(contracts.skipped?.phase).toBe(1);
        expect(contracts.skipped?.reason).toContain(reason);
      });
    }

    test("a foundation author that dies", async () => {
      const run = await runPlan([1, 2, 3], { failing: [1] });

      expect(run.error).toBeUndefined();
      expect(run.result?.ok).toBe(false);
      expect((run.result?.phases as { failed: number[] }).failed).toEqual([1]);
      expect(run.events).toContain("end:2");
      expect(run.events).toContain("end:3");
      const contracts = run.result?.contracts as { skipped: { phase: number; reason: string } };
      expect(contracts.skipped).toEqual({
        phase: 1,
        reason: "the foundation author produced nothing",
      });
    });
  });
});

describe("plan-author-audit args.contracts", () => {
  test("reaches every author prompt, the foundation's included", async () => {
    const run = await runPlan([1, 2, 3], {
      args: { contracts: OPERATOR_CONTRACTS },
      tails: { 1: CONTRACT_SECTION },
    });

    expect(run.result?.ok).toBe(true);
    for (const n of [1, 2, 3]) expect(run.authorPrompts.get(n)).toContain(OPERATOR_CONTRACTS);
    expect((run.result?.contracts as { operator_chars: number }).operator_chars).toBe(
      OPERATOR_CONTRACTS.length,
    );
  });

  test("reaches every author prompt when authoring is fully parallel", async () => {
    const run = await runPlan([1, 2], {
      args: { contracts: OPERATOR_CONTRACTS, foundationFirst: false },
    });

    for (const n of [1, 2]) expect(run.authorPrompts.get(n)).toContain(OPERATOR_CONTRACTS);
  });

  test("fails closed before any agent runs on a bad contracts or foundationFirst arg", async () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ contracts: 42 }, "bad_contracts:"],
      [{ contracts: ["a", "b"] }, "bad_contracts:"],
      [{ contracts: "x".repeat(20_001) }, "bad_contracts:"],
      [{ contracts: "/abs/path/contracts.md" }, "bad_contracts:"],
      [{ foundationFirst: "no" }, "bad_foundation_first:"],
    ];
    for (const [args, prefix] of bad) {
      const run = await runPlan([1, 2], { args });
      expect(run.error).toBeUndefined();
      expect(run.result?.ok).toBe(false);
      expect(String(run.result?.error)).toStartWith(prefix);
      expect(run.agentCalls).toBe(0);
    }
  });
});
