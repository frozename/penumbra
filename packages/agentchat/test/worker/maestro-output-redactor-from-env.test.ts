import { expect, test } from "bun:test";
import { buildMaestroRedactorFromEnv } from "../../src/worker/maestro-output-redactor.js";

test("buildMaestroRedactorFromEnv returns bypass=true when env var is set to 1", () => {
  const r = buildMaestroRedactorFromEnv({
    env: { PENUMBRA_MAESTRO_REDACTION_BYPASS: "1" },
    knownAgents: new Set(["planner"]),
  });
  const { decision, bypassed } = r.checkContent("rm -rf /Volumes/WorkSSD");
  expect(decision).toBe("bypassed");
  expect(bypassed).toBe(true);
});

test("buildMaestroRedactorFromEnv default is bypass=false", () => {
  const r = buildMaestroRedactorFromEnv({
    env: {},
    knownAgents: new Set(["planner"]),
  });
  const { decision } = r.checkContent("rm -rf /Volumes/WorkSSD");
  expect(decision).toBe("blocked");
});

test('buildMaestroRedactorFromEnv treats "0", "false", "" as off-by-default (no bypass)', () => {
  for (const val of ["0", "false", "", "no"]) {
    const r = buildMaestroRedactorFromEnv({
      env: { PENUMBRA_MAESTRO_REDACTION_BYPASS: val },
      knownAgents: new Set(["planner"]),
    });
    const { decision } = r.checkContent("rm -rf /Volumes/WorkSSD");
    expect(decision).toBe("blocked");
  }
});

test('buildMaestroRedactorFromEnv treats "true" and "yes" as bypass', () => {
  for (const val of ["true", "TRUE", "yes", "YES"]) {
    const r = buildMaestroRedactorFromEnv({
      env: { PENUMBRA_MAESTRO_REDACTION_BYPASS: val },
      knownAgents: new Set(["planner"]),
    });
    const { decision } = r.checkContent("rm -rf /Volumes/WorkSSD");
    expect(decision).toBe("bypassed");
  }
});
