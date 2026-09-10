import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";

type DispositionStatus =
  | "unavailable"
  | "qualified"
  | "retained-specialist"
  | "retired-by-decision";

type DispositionRow = {
  name: string;
  status: DispositionStatus;
  replacement: string;
  owner: string;
  input_contract: string;
  result_contract: string;
  side_effects: string;
  test_path: string;
  evidence: unknown[];
};

type FullCodexParityEvidence = {
  kind: "full-codex-parity";
  codex_invocation: string;
  codex_input: string;
  codex_result: string;
  codex_effect: string;
};

function isDispositionRow(value: unknown): value is DispositionRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.name === "string" &&
    typeof row.status === "string" &&
    typeof row.replacement === "string" &&
    typeof row.owner === "string" &&
    typeof row.input_contract === "string" &&
    typeof row.result_contract === "string" &&
    typeof row.side_effects === "string" &&
    typeof row.test_path === "string" &&
    Array.isArray(row.evidence)
  );
}

function isFullCodexParityEvidence(value: unknown): value is FullCodexParityEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (
    evidence.kind === "full-codex-parity" &&
    typeof evidence.codex_invocation === "string" &&
    evidence.codex_invocation.length > 0 &&
    typeof evidence.codex_input === "string" &&
    evidence.codex_input.length > 0 &&
    typeof evidence.codex_result === "string" &&
    evidence.codex_result.length > 0 &&
    typeof evidence.codex_effect === "string" &&
    evidence.codex_effect.length > 0
  );
}

const EXPECTED_OWNERS: Record<string, string> = {
  "penumbra-fanout": "workflow-dispatch-remediation/phases10-11",
  "penumbra-fix-until-green": "workflow-dispatch-remediation/phases10-11",
  "penumbra-fleet-verify": "workflow-dispatch-remediation/phases10-11",
  "penumbra-swarm": "workflow-dispatch-remediation/phases10-11",
  "penumbra-tournament": "workflow-dispatch-remediation/phases10-11",
  "penumbra-loop-discover-to-green": "workflow-dispatch-remediation/phases10-11",
  "penumbra-research": "workflow-dispatch-remediation/phases10-11",
  "adversarial-review": "codex-harness-parity/6.4",
  "penumbra-review-sweep": "codex-harness-parity/6.4",
  "adversarial-plan-topic": "codex-harness-parity/6.2",
  "adversarial-plan-integration": "codex-harness-parity/6.2",
  "session-first-moves": "codex-harness-parity/6.2",
  "session-memory-sweep": "codex-harness-parity/6.2",
  "integration-audit": "codex-harness-parity/6.3.3",
  "plan-author-audit": "codex-harness-parity/6.3.2",
  "plan-verify-recon": "codex-harness-parity/6.3.1",
  "land-and-close": "codex-harness-parity/6.5",
  "penumbra-token-opt-migrate": "codex-harness-parity/6.5",
  "penumbra-token-opt-batch": "codex-harness-parity/6.5",
};

const TEST_PATH_PATTERN = /^(planned: )?([A-Za-z0-9][A-Za-z0-9._/-]*\.test\.ts)$/;

async function isValidTestPath(testPath: string): Promise<boolean> {
  const match = TEST_PATH_PATTERN.exec(testPath);
  const plannedPrefix = match?.[1];
  const candidatePath = match?.[2];
  if (
    !candidatePath ||
    candidatePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }
  if (plannedPrefix) return true;
  try {
    return (await stat(candidatePath)).isFile();
  } catch {
    return false;
  }
}

test("every shipped CC script has one disposition with evidence requirements", async () => {
  const scripts = (await readdir(".claude/workflows"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.slice(0, -3))
    .sort();
  const parsed: unknown = JSON.parse(
    await readFile("docs/codex-setup/workflow-disposition.json", "utf8"),
  );
  if (!Array.isArray(parsed)) {
    throw new Error("workflow disposition ledger must be an array");
  }
  if (!parsed.every(isDispositionRow)) {
    throw new Error("workflow disposition ledger must contain valid rows");
  }
  const rows = parsed;

  expect(rows.map((row) => row.name).sort()).toEqual(scripts);
  expect(Object.fromEntries(rows.map((row) => [row.name, row.owner]))).toEqual(EXPECTED_OWNERS);
  for (const row of rows) {
    expect(["unavailable", "qualified", "retained-specialist", "retired-by-decision"]).toContain(
      row.status,
    );
    for (const key of [
      "replacement",
      "owner",
      "input_contract",
      "result_contract",
      "side_effects",
      "test_path",
    ] as const) {
      expect(typeof row[key]).toBe("string");
      expect(row[key].length).toBeGreaterThan(0);
    }
    if (row.status === "qualified" || row.status === "retired-by-decision") {
      expect(row.evidence.length).toBeGreaterThan(0);
    }
    if (row.status === "qualified") {
      expect(row.evidence.some(isFullCodexParityEvidence)).toBe(true);
    }
  }
});

test("every workflow disposition test path is concrete or explicitly planned", async () => {
  const parsed: unknown = JSON.parse(
    await readFile("docs/codex-setup/workflow-disposition.json", "utf8"),
  );
  if (!Array.isArray(parsed) || !parsed.every(isDispositionRow)) {
    throw new Error("workflow disposition ledger must contain valid rows");
  }

  for (const row of parsed) {
    expect(await isValidTestPath(row.test_path), `${row.name}: ${row.test_path}`).toBe(true);
  }
});
