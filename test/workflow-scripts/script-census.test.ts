import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const WORKFLOW_DIR = resolve(".claude/workflows");
const FIXTURE_PATH = resolve("test/workflow-scripts/task-spec-validation.test.ts");

const UNGUARDED: Record<string, string> = {
  "adversarial-plan-integration.js":
    "adversarial plan synthesis; chain_start appears only in planning context, no real dispatch",
  "adversarial-plan-topic.js": "single-topic adversarial planning; no dispatch",
  "adversarial-review.js":
    "daemon adversarial-review wrapper; one optional chain_start for the HIGH-fix round, not a public task spec",
  "integration-audit.js":
    "read-only integration audit; chain_start appears only in a probe prompt, no real dispatch",
  "land-and-close.js": "post-dispatch land/verify/close tail; uses dispatch_land, not chain_start",
  "penumbra-loop-discover-to-green.js":
    "full discover->plan->implement->review loop; self-guarded by task-spec-validation block, no direct chain_start",
  "penumbra-research.js": "memory-augmented web research; no dispatch",
  "penumbra-review-sweep.js":
    "sweep of adversarial-review targets; self-guarded by task-spec-validation block, no direct chain_start",
  "penumbra-token-opt-batch.js":
    "batch token-opt migrations with real chain_start calls; the dispatch contract is caller-provided",
  "penumbra-token-opt-migrate.js":
    "single token-opt migration with a real chain_start call; hardcoded param shape",
  "penumbra-tournament.js":
    "best-of-N fleet tournament; self-guarded by task-spec-validation block, no direct chain_start",
  "session-first-moves.js": "read-only session diagnostics, no dispatch",
  "session-memory-sweep.js": "t2 memory candidate collect/approve; no chain_start dispatch",
};

const UNGUARDED_EXPECTED_SIZE = 13;

function readWorkflowsFixture(): string[] {
  const source = readFileSync(FIXTURE_PATH, "utf8");
  const match = source.match(/const\s+WORKFLOWS\s*=\s*\[([\s\S]*?)\];/);
  if (!match || typeof match[1] !== "string") {
    throw new Error("WORKFLOWS fixture not found in task-spec-validation.test.ts");
  }
  const block = match[1];
  const paths: string[] = [];
  for (const m of block.matchAll(/path:\s*"([^"]+)"/g)) {
    const path = m[1];
    if (typeof path !== "string") {
      throw new Error("WORKFLOWS fixture path parse failed");
    }
    paths.push(path);
  }
  return paths.map((p) => basename(p));
}

describe("workflow script census", () => {
  const allJs = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();
  const fixtureNames = new Set(readWorkflowsFixture());

  test("every .js is in the WORKFLOWS fixture or the UNGUARDED ledger", () => {
    const problems: string[] = [];

    for (const file of allJs) {
      if (fixtureNames.has(file)) {
        if (Object.hasOwn(UNGUARDED, file)) {
          problems.push(`${file} is in WORKFLOWS but also in UNGUARDED (stale ledger)`);
        }
        continue;
      }
      const reason = UNGUARDED[file];
      if (typeof reason !== "string" || reason.length === 0) {
        problems.push(`${file} is not in WORKFLOWS and has no UNGUARDED reason`);
      }
    }

    for (const file of Object.keys(UNGUARDED)) {
      if (fixtureNames.has(file)) {
        problems.push(`${file} in UNGUARDED is also in WORKFLOWS (stale ledger)`);
      } else if (!allJs.includes(file)) {
        problems.push(`${file} in UNGUARDED does not exist in .claude/workflows`);
      }
    }

    expect(Object.keys(UNGUARDED).length).toBe(UNGUARDED_EXPECTED_SIZE);
    expect(problems).toEqual([]);
  });

  test("every script containing chain_start has a task-spec-validation fence or an UNGUARDED reason", () => {
    const problems: string[] = [];

    for (const file of allJs) {
      const source = readFileSync(resolve(WORKFLOW_DIR, file), "utf8");
      if (!source.includes("chain_start")) continue;

      const hasFence = source.includes("// task-spec-validation:begin");
      const inUnguarded = Object.hasOwn(UNGUARDED, file);

      if (!hasFence && !inUnguarded) {
        problems.push(
          `${file} contains chain_start but has no task-spec-validation fence and is not in UNGUARDED`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});
