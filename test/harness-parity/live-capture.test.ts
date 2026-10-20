import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseCapabilityFixture } from "./capability-contract.js";
import { qualifyCodexHookReport } from "../../packages/cli/src/commands/codex-hook-capabilities.js";

const OBSERVED_PATH = "../../packages/cli/test/fixtures/codex-hooks/observed-capabilities.json";

const observed = JSON.parse(readFileSync(join(import.meta.dir, OBSERVED_PATH), "utf8")) as {
  report: {
    surface: "cli" | "desktop";
    build: string | null;
    cleanupComplete: boolean;
    cases: Array<{
      fixture: Record<string, unknown>;
      reason: string | null;
      scenario?: string;
    }>;
  };
};

function findScenario(capability: string, scenario: string) {
  return observed.report.cases.find(
    (case_) => case_.fixture.capability === capability && case_.scenario === scenario,
  );
}

test("every committed observed fixture parses without errors", () => {
  for (const observation of observed.report.cases) {
    expect(() => parseCapabilityFixture(observation.fixture)).not.toThrow();
  }
});

test("the committed report qualifies exactly four CLI hook scenarios for the observed build", () => {
  const report = observed.report;
  const qualification = qualifyCodexHookReport(report, "0.153.4");

  expect(report.surface).toBe("cli");
  expect(report.build).toBe("0.153.4");
  expect(report.cleanupComplete).toBe(true);
  expect(qualification.hooks).toHaveLength(4);
  expect(qualification.hooks.map((hook) => `${hook.event}:${hook.matcher ?? ""}`).sort()).toEqual([
    "PostToolUse:^Bash$",
    "PreToolUse:^Bash$",
    "SessionStart:^startup$",
    "Stop:",
  ]);
});

test("unproven scenarios remain unknown, including prompt and deferred bash completion", () => {
  const prompt = findScenario("UserPromptSubmit", "prompt");
  const deferred = findScenario("PostToolUse", "deferred_bash_completion");

  expect(prompt?.fixture.state).toBe("unknown");
  expect(prompt?.reason).toBe("user_prompt_input_contract_not_validated");
  expect(deferred?.fixture.state).toBe("unknown");
  expect(deferred?.reason).toBe("deferred_completion_correlation_not_validated");
});

test("the bash PreToolUse and PostToolUse observations share session and tool identity", () => {
  const pre = findScenario("PreToolUse", "bash");
  const post = findScenario("PostToolUse", "bash");

  expect(pre?.fixture.state).toBe("supported");
  expect(post?.fixture.state).toBe("supported");

  const preInput = pre?.fixture.input as Record<string, unknown> | undefined;
  const postInput = post?.fixture.input as Record<string, unknown> | undefined;
  const preIdentity = pre?.fixture.identity as Record<string, unknown> | undefined;
  const postIdentity = post?.fixture.identity as Record<string, unknown> | undefined;

  expect(preInput?.session_id).toBe(preIdentity?.sessionId);
  expect(postInput?.session_id).toBe(postIdentity?.sessionId);
  expect(preInput?.session_id).toBe(postInput?.session_id);
  expect(preInput?.turn_id).toBe(postInput?.turn_id);
  expect(preInput?.tool_use_id).toBe(postInput?.tool_use_id);
  expect(postInput?.tool_response).toBe(`${postInput?.cwd}\n`);
});

test("qualification rejects desktop surface and build mismatches", () => {
  const desktop = JSON.parse(JSON.stringify(observed.report)) as typeof observed.report;
  desktop.surface = "desktop";
  const desktopQualification = qualifyCodexHookReport(desktop, "0.153.4");
  expect(desktopQualification.hooks).toHaveLength(0);
  expect(desktopQualification.detail).toContain("desktop");

  const wrongBuild = qualifyCodexHookReport(observed.report, "0.153.5");
  expect(wrongBuild.hooks).toHaveLength(0);
  expect(wrongBuild.detail).toContain("build");
});
