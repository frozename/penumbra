import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { runPlanValidate } from "../../src/commands/plan.js";

test("validator fires on legacy workflow-runtime plan with no yaml meta blocks", async () => {
  const planPath = resolve(__dirname, "../fixtures/2026-05-04-workflow-runtime.md");
  const errs: string[] = [];
  const out: string[] = [];
  const code = await runPlanValidate({
    path: planPath,
    knownAgents: new Set(["codex-acp-fast", "claude-acp-sonnet"]),
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
  });
  expect(code).toBe(2);
  expect(errs.some((line) => line.includes("parse:") && line.includes(planPath))).toBe(true);
});
