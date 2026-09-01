import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const PLAYBOOK_PATH = resolve(
  import.meta.dir,
  "../../../..",
  "plugin/playbooks/maestro-context-prime/playbook.md",
);

const REQUIRED_CC_WORKFLOW_NAMES = [
  "penumbra-fanout",
  "penumbra-fix-until-green",
  "penumbra-review-sweep",
  "penumbra-tournament",
  "penumbra-research",
] as const;

test("maestro-context-prime playbook names the real CC Workflow identifiers for fan-out/fix-until-green/review-sweep/tournament/research", () => {
  const content = readFileSync(PLAYBOOK_PATH, "utf8");
  for (const name of REQUIRED_CC_WORKFLOW_NAMES) {
    expect(content).toContain(name);
  }
});

test("maestro-context-prime playbook does NOT tell maestro to invoke fan-out/fix-until-green/review-sweep/tournament/research via workflow_run (they are not daemon-registered)", () => {
  const content = readFileSync(PLAYBOOK_PATH, "utf8");
  // The playbook must plainly state that these names are not resolvable via workflow_run.
  // We look for a sentence that ties `workflow_run` to `not_found` or an explicit "not" phrase near the CC workflow names.
  const notResolvableMarkers = [
    /not\s+(daemon-)?registered/i,
    /not_found/i,
    /not\s+resolvable\s+via\s+`?workflow_run`?/i,
  ];
  const hitsAny = notResolvableMarkers.some((re) => re.test(content));
  expect(hitsAny).toBe(true);
});

test("maestro-context-prime recall budget covers protected payload byte caps", () => {
  const content = readFileSync(PLAYBOOK_PATH, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  expect(match).not.toBeNull();
  const frontmatter = parseYaml(match?.[1] ?? "") as {
    recall_budget_tokens?: number;
    recall?: { source?: string; args?: { max_bytes?: number } }[];
  };
  const latestContinuation = frontmatter.recall?.find(
    (source) => source.source === "latest_continuation_note",
  );
  const pendingDraft = frontmatter.recall?.find((source) => source.source === "file.contents");
  const recallSource = readFileSync(
    resolve(import.meta.dir, "../../../workflows/src/recall.ts"),
    "utf8",
  );

  // Keep this tripwire aligned with recall.ts TOKEN_PER_CHAR so payload caps cannot outgrow budget.
  expect(recallSource).toContain("TOKEN_PER_CHAR = 0.25");
  const tokenPerChar = 0.25;
  const requiredBudget =
    Math.ceil(
      ((latestContinuation?.args?.max_bytes ?? 0) + (pendingDraft?.args?.max_bytes ?? 0)) *
        tokenPerChar,
    ) + 1_500;

  expect(frontmatter.recall_budget_tokens ?? 0).toBeGreaterThanOrEqual(requiredBudget);
});
