import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
