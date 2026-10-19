import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: unknown;
}

type AgentFn = (prompt: string, opts: AgentOpts) => Promise<unknown>;
type ParallelFn = (items: Array<() => unknown>) => Promise<unknown[]>;
type PhaseFn = (name: string, fn?: () => unknown) => unknown;
type LogFn = (...args: unknown[]) => void;

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new Error("unterminated export const meta object");
}

function readRuntimeBody(path: string): string {
  const source = readFileSync(resolve(path), "utf8");
  const marker = "export const meta";
  const start = source.indexOf(marker);
  expect(start, `${path} should include export const meta`).toBeGreaterThanOrEqual(0);
  const equals = source.indexOf("=", start + marker.length);
  expect(equals, `${path} should assign export const meta`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", equals);
  expect(open, `${path} should assign an object literal to meta`).toBeGreaterThanOrEqual(0);
  const close = findMatchingBrace(source, open);
  const after = source[close + 1] === ";" ? close + 2 : close + 1;

  return source.slice(0, start) + source.slice(after);
}

interface RunResult {
  result: unknown;
  calls: number;
  prompts: string[];
}

async function runWorkflow(path: string, args: unknown, agent: AgentFn): Promise<RunResult> {
  const body = readRuntimeBody(path);
  const prompts: string[] = [];
  let calls = 0;
  const wrappedAgent: AgentFn = async (prompt, opts) => {
    calls++;
    prompts.push(String(prompt));
    return agent(prompt, opts);
  };
  const parallel: ParallelFn = async (items) => Promise.all(items.map((item) => item()));
  const phase: PhaseFn = (_name, fn) => (fn ? fn() : undefined);
  const log: LogFn = () => {};
  const run = new Function(
    "args",
    "agent",
    "parallel",
    "phase",
    "log",
    `"use strict"; return (async () => {\n${body}\n})();`,
  ) as (
    args: unknown,
    agent: AgentFn,
    parallel: ParallelFn,
    phase: PhaseFn,
    log: LogFn,
  ) => Promise<unknown>;

  const result = await run(args, wrappedAgent, parallel, phase, log);
  return { result, calls, prompts };
}

const throwingAgent: AgentFn = async () => {
  throw new Error("agent should not have been called");
};

describe("report-only workflow parse-error rethrows", () => {
  const cases: Array<{ name: string; path: string }> = [
    {
      name: "adversarial-plan-integration",
      path: ".claude/workflows/adversarial-plan-integration.js",
    },
    { name: "adversarial-plan-topic", path: ".claude/workflows/adversarial-plan-topic.js" },
    { name: "integration-audit", path: ".claude/workflows/integration-audit.js" },
    { name: "session-memory-sweep", path: ".claude/workflows/session-memory-sweep.js" },
    { name: "session-first-moves", path: ".claude/workflows/session-first-moves.js" },
  ];

  for (const { name, path } of cases) {
    test(`${name} throws on invalid JSON string args`, async () => {
      await expect(runWorkflow(path, "{not json}", throwingAgent)).rejects.toThrow(
        /is not valid JSON/,
      );
    });
  }
});

describe("adversarial-plan-integration", () => {
  test("does not hand a frozen SHA to planner personas", async () => {
    const prompts: string[] = [];
    const agent: AgentFn = async (prompt) => {
      prompts.push(String(prompt));
      return "plan";
    };

    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-integration.js",
      { head_sha: "abc1234" },
      agent,
    );

    expect(result).toMatchObject({ ok: true, plan: "plan" });
    expect(calls).toBe(6); // 5 personas + 1 synthesizer
    const personaPrompt = prompts.find((p) => p.includes("Proven loop"));
    expect(personaPrompt).toBeDefined();
    expect(personaPrompt).toContain("origin/main == HEAD == abc1234");
    expect(personaPrompt).not.toContain("a8e327b6");
  });

  test("warns not to invent a SHA when head_sha is not provided", async () => {
    const agent: AgentFn = async () => "plan";

    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-integration.js",
      {},
      agent,
    );

    expect(result).toMatchObject({ ok: true, plan: "plan" });
    expect(calls).toBe(6);
  });

  test("returns ok:false when every persona lens dies", async () => {
    const agent: AgentFn = async () => null;

    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-integration.js",
      {},
      agent,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "adversarial-plan-integration: all persona lenses failed",
      plan: null,
      failed: 5,
    });
    expect(calls).toBe(5); // no synthesizer called
  });

  test("returns ok:false for a degraded run with partial persona failure", async () => {
    let call = 0;
    const agent: AgentFn = async () => {
      call++;
      return call <= 2 ? null : "plan";
    };

    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-integration.js",
      {},
      agent,
    );

    expect(result).toMatchObject({
      ok: false,
      failed: 2,
      plan: "plan",
    });
    expect(calls).toBe(6); // 5 personas + 1 synthesizer
  });
});

describe("adversarial-plan-topic", () => {
  test("returns ok:false and does not fan out on empty spec", async () => {
    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-topic.js",
      {},
      throwingAgent,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "adversarial-plan-topic: empty spec — args did not arrive",
    });
    expect(calls).toBe(0);
  });

  test("returns ok:false when every persona lens dies", async () => {
    const agent: AgentFn = async () => null;

    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-topic.js",
      { spec: "# Topic\nPlan the thing." },
      agent,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "adversarial-plan-topic: all persona lenses failed",
      plan: null,
      failed: 4,
    });
    expect(calls).toBe(4); // no synthesizer called
  });

  test("returns ok:true when all persona lenses produce a plan", async () => {
    const agent: AgentFn = async () => "plan";

    const { result, calls } = await runWorkflow(
      ".claude/workflows/adversarial-plan-topic.js",
      { spec: "# Topic\nPlan the thing." },
      agent,
    );

    expect(result).toMatchObject({
      ok: true,
      failed: 0,
      plan: "plan",
    });
    expect(calls).toBe(5); // 4 personas + 1 synthesizer
  });
});

describe("integration-audit", () => {
  const baseFinding = {
    present: true,
    wired: true,
    evidence: "found",
    gaps: "none",
    score: 8,
  };

  function makeAuditAgent(outcome: { failCritical?: boolean } = {}): AgentFn {
    return async (_prompt, opts) => {
      if (opts.phase === "Probe") {
        return {
          surface: "mutual-reinforcement",
          ...baseFinding,
        };
      }
      if (opts.phase === "Synthesize") {
        return {
          integrated: !outcome.failCritical,
          overall_score: 100,
          summary: "synth",
          reinforcements: [],
          remaining_gaps: [],
          recommended_next: [],
        };
      }
      return null;
    };
  }

  test("expands HOME to an absolute path in probe prompts", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/mock/home";
    const prompts: string[] = [];
    const agent: AgentFn = async (prompt, opts) => {
      if (opts.phase === "Probe") prompts.push(String(prompt));
      return opts.phase === "Probe"
        ? { surface: "mutual-reinforcement", ...baseFinding }
        : {
            integrated: true,
            overall_score: 100,
            summary: "s",
            reinforcements: [],
            remaining_gaps: [],
            recommended_next: [],
          };
    };

    try {
      await runWorkflow(".claude/workflows/integration-audit.js", { repo: "/mock/repo" }, agent);
      const protocolPrompt = prompts.find((p) => p.includes("Anti-fabrication protocol"));
      expect(protocolPrompt).toBeDefined();
      expect(protocolPrompt).toContain("/mock/home/.claude/CLAUDE.md");
      expect(protocolPrompt).not.toContain("${HOME}");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("ok is true only when every critical surface is present and wired", async () => {
    const surfaces = [
      "anti-fabrication-protocol",
      "data-loss-guard-hook",
      "cc-workflow-lifecycle",
      "proof-of-loop",
      "mutual-reinforcement",
    ];
    let probe = 0;
    const agent: AgentFn = async (_prompt, opts) => {
      if (opts.phase === "Probe") {
        const surface = surfaces[probe++];
        return { surface, ...baseFinding };
      }
      return {
        integrated: true,
        overall_score: 100,
        summary: "s",
        reinforcements: [],
        remaining_gaps: [],
        recommended_next: [],
      };
    };

    const { result } = await runWorkflow(
      ".claude/workflows/integration-audit.js",
      { repo: "/mock/repo" },
      agent,
    );

    expect(result).toMatchObject({
      ok: true,
      integrated: true,
    });
    expect((result as { synthesis?: { integrated?: boolean } }).synthesis?.integrated).toBe(true);
  });

  test("ok is false when a critical surface is not wired, and synthesizer verdict is overridden", async () => {
    const surfaces = [
      "anti-fabrication-protocol",
      "data-loss-guard-hook",
      "cc-workflow-lifecycle",
      "proof-of-loop",
      "mutual-reinforcement",
    ];
    let probe = 0;
    const agent: AgentFn = async (_prompt, opts) => {
      if (opts.phase === "Probe") {
        const surface = surfaces[probe++];
        return surface === "data-loss-guard-hook"
          ? { surface, ...baseFinding, wired: false }
          : { surface, ...baseFinding };
      }
      return {
        integrated: true,
        overall_score: 100,
        summary: "s",
        reinforcements: [],
        remaining_gaps: [],
        recommended_next: [],
      };
    };

    const { result } = await runWorkflow(
      ".claude/workflows/integration-audit.js",
      { repo: "/mock/repo" },
      agent,
    );

    expect(result).toMatchObject({
      ok: false,
      integrated: false,
    });
    expect((result as { synthesis?: { integrated?: boolean } }).synthesis?.integrated).toBe(false);
  });
});

describe("land-and-close", () => {
  test("returns no_repo_scope before calling agent when repo is relative", async () => {
    const { result, calls } = await runWorkflow(
      ".claude/workflows/land-and-close.js",
      { handoff_id: "h1", commit_message: "msg", repo: "relative/path" },
      throwingAgent,
    );

    expect(result).toMatchObject({
      ok: false,
      notes: "no_repo_scope: repo must be an absolute path",
    });
    expect(calls).toBe(0);
  });

  test("completes land/verify/close with an absolute repo", async () => {
    const agent: AgentFn = async (_prompt, opts) => {
      if (opts.label === "land") return { commit_sha: "abc1234", error: "" };
      if (opts.label === "verify")
        return { head: "abc1234", commit_sha: "abc1234", files_changed: 1, verified: true };
      if (opts.label === "close") return { lane_status: "closed", task_status: "resolved" };
      return null;
    };

    const { result, calls } = await runWorkflow(
      ".claude/workflows/land-and-close.js",
      {
        handoff_id: "h1",
        commit_message: "msg",
        repo: "/abs/repo",
        lane_id: "l1",
        board_task_id: "t1",
      },
      agent,
    );

    expect(result).toMatchObject({
      ok: true,
      commit_sha: "abc1234",
      head_verified: true,
      lane_status: "closed",
      task_status: "resolved",
    });
    expect(calls).toBe(3);
  });

  test("STEP 3 names supersede_requires_review_evidence and never invites an override", async () => {
    const prompts: string[] = [];
    const agent: AgentFn = async (prompt, opts) => {
      prompts.push(String(prompt));
      if (opts.label === "land") return { commit_sha: "abc1234", error: "" };
      if (opts.label === "verify")
        return { head: "abc1234", commit_sha: "abc1234", files_changed: 1, verified: true };
      if (opts.label === "close") return { lane_status: "closed", task_status: "skipped" };
      return null;
    };

    const { result } = await runWorkflow(
      ".claude/workflows/land-and-close.js",
      { handoff_id: "h1", commit_message: "msg", repo: "/abs/repo", lane_id: "l1" },
      agent,
    );

    expect(result).toMatchObject({ ok: true });
    const closePrompt = prompts.find((p) => p.includes("STEP 3"));
    expect(closePrompt).toBeDefined();
    // A swept lane closed without reviewer evidence returns 400
    // supersede_requires_review_evidence; the prompt must name it and tell the
    // close agent to report the ledger row instead of retrying.
    expect(closePrompt!).toContain("400 supersede_requires_review_evidence");
    expect(closePrompt!).toContain("do NOT add an override_reason");
    expect(closePrompt!).toContain("lane_ledger_recent");
    expect(closePrompt!).toContain("NEVER retry");
    // NEVER retry must apply to every lane_close error, not only the named ones.
    expect(closePrompt!).toMatch(/any lane_close error/i);
    // The close agent authoring its own override_reason could launder a
    // review_debt sweeper stamp into passed — the prompt must not offer it.
    expect(closePrompt!).not.toContain("explicit override_reason");
  });
});

describe("session-first-moves", () => {
  const OPEN_PR_KEYS = [
    "author",
    "checks",
    "created_at",
    "head_ref",
    "not_from_known_lane",
    "number",
    "title",
  ];

  for (const soak of [false, true]) {
    test(`${soak ? "soak" : "default"} schema admits the collector's open_prs field`, async () => {
      let schema: unknown;
      const agent: AgentFn = async (_prompt, opts) => {
        schema = opts.schema;
        return {};
      };

      await runWorkflow(".claude/workflows/session-first-moves.js", { soak }, agent);

      const root = schema as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };
      expect(root.additionalProperties).toBe(false);
      const openPrs = root.properties?.["open_prs"] as
        | {
            additionalProperties?: boolean;
            properties?: {
              prs?: { type?: unknown; items?: { properties?: Record<string, unknown> } };
              reason?: { type?: unknown };
            };
          }
        | undefined;
      expect(openPrs?.additionalProperties).toBe(false);
      expect(openPrs?.properties?.prs?.type).toEqual(["array", "null"]);
      expect(openPrs?.properties?.reason?.type).toEqual(["string", "null"]);
      expect(Object.keys(openPrs?.properties?.prs?.items?.properties ?? {}).sort()).toEqual(
        OPEN_PR_KEYS,
      );
    });
  }
});
