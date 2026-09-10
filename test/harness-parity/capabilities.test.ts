import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertHookOutput, parseCapabilityFixture } from "./capability-contract.js";

type InputCase = { name: string; fixture: unknown; valid: boolean; expectedError: string | null };
type OutputCase = { event: string; output: unknown; valid: boolean };

const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../packages/cli/test/fixtures/codex-hooks/contract-cases.json"),
    "utf8",
  ),
) as { inputs: InputCase[]; outputs: OutputCase[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixtureInput(name: string): Record<string, unknown> {
  const row = cases.inputs.find((candidate) => candidate.name === name);
  if (!row || !isRecord(row.fixture)) {
    throw new Error(`missing fixture input: ${name}`);
  }
  return structuredClone(row.fixture);
}

function recordField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const candidate = value[field];
  if (!isRecord(candidate)) {
    throw new Error(`missing fixture field: ${field}`);
  }
  return candidate;
}

for (const row of cases.inputs) {
  test(`fixture input: ${row.name}`, () => {
    if (row.valid) {
      const parsed = parseCapabilityFixture(row.fixture);
      expect(row.fixture).toEqual(parsed);
      return;
    }
    expect(() => parseCapabilityFixture(row.fixture)).toThrow(row.expectedError!);
  });
}

for (const row of cases.outputs) {
  test(`fixture output: ${row.event}`, () => {
    if (row.valid) {
      expect(() => assertHookOutput(row.event, row.output)).not.toThrow();
      return;
    }
    expect(() => assertHookOutput(row.event, row.output)).toThrow();
  });
}

test("feature metadata cannot establish live Codex support", () => {
  expect(() =>
    parseCapabilityFixture({
      surface: "cli",
      build: "0.153.4",
      capability: "SessionStart",
      state: "supported",
      evidence: {
        kind: "contract",
        surface: "cli",
        source: "release-docs",
        observedAt: "2026-09-10T00:00:00.000Z",
        probeId: null,
      },
    }),
  ).toThrow("live_evidence_required");
});

test("PreToolUse rejects output fields belonging to another event", () => {
  expect(() => assertHookOutput("PreToolUse", { continue: false })).toThrow();
  expect(() => assertHookOutput("Stop", {})).not.toThrow();
});

test("fixtures bind the raw hook event to their capability", () => {
  const fixture = fixtureInput("root-non-uuid");
  recordField(fixture, "input").hook_event_name = "Stop";

  expect(() => parseCapabilityFixture(fixture)).toThrow("hook_capability_mismatch");
});

test("fixtures reject invented raw hook fields", () => {
  const fixture = fixtureInput("root-non-uuid");
  recordField(fixture, "input").invented_host_field = true;

  expect(() => parseCapabilityFixture(fixture)).toThrow("unsupported_hook_input_field");
});

test("fixtures reject an actually missing raw cwd", () => {
  const fixture = fixtureInput("root-non-uuid");
  delete recordField(fixture, "input").cwd;

  expect(() => parseCapabilityFixture(fixture)).toThrow("missing_hook_input_field");
});

test("documented common hook fields must be present while null transcripts remain valid", () => {
  const fixture = fixtureInput("root-non-uuid");
  const input = recordField(fixture, "input");
  input.transcript_path = null;
  input.model = "gpt-5.6-terra";
  input.permission_mode = "default";

  expect(() => parseCapabilityFixture(fixture)).not.toThrow();
  for (const field of ["transcript_path", "model", "permission_mode"]) {
    const missing = structuredClone(fixture);
    delete recordField(missing, "input")[field];
    expect(() => parseCapabilityFixture(missing)).toThrow("missing_hook_input_field");
  }
});

test("SessionStart source is a documented enum", () => {
  const fixture = fixtureInput("root-non-uuid");
  const input = recordField(fixture, "input");
  input.transcript_path = null;
  input.model = "gpt-5.6-terra";
  input.permission_mode = "default";
  input.source = "clear";

  expect(() => parseCapabilityFixture(fixture)).not.toThrow();
  input.source = "restored-from-backup";
  expect(() => parseCapabilityFixture(fixture)).toThrow("invalid_hook_input");
});

test("only documented event branches receive permission_mode", () => {
  for (const name of ["precompact", "session-end"]) {
    const fixture = fixtureInput(name);
    const input = recordField(fixture, "input");
    input.transcript_path = null;
    input.model = "gpt-5.6-terra";

    expect(() => parseCapabilityFixture(fixture)).not.toThrow();
    input.permission_mode = "default";
    expect(() => parseCapabilityFixture(fixture)).toThrow("unsupported_hook_input_field");
  }
});

test("SubagentStop fixtures require child metadata and a raw agent id", () => {
  const fixture = fixtureInput("child");
  const identity = recordField(fixture, "identity");
  identity.role = "root";
  identity.agentId = null;
  delete recordField(fixture, "input").agent_id;

  expect(() => parseCapabilityFixture(fixture)).toThrow("child_identity_required");
});

test("unavailable fixtures require nonblank same-surface live evidence", () => {
  const fixture = fixtureInput("root-non-uuid");
  fixture.state = "unavailable";
  fixture.build = null;
  const evidence = recordField(fixture, "evidence");
  evidence.kind = "contract";
  evidence.probeId = "invented";

  expect(() => parseCapabilityFixture(fixture)).toThrow("live_evidence_required");
});

test("live evidence identifiers and builds cannot be whitespace", () => {
  const fixture = fixtureInput("root-non-uuid");
  fixture.state = "unavailable";
  fixture.build = " ";
  const evidence = recordField(fixture, "evidence");
  evidence.kind = "live";
  evidence.probeId = " ";

  expect(() => parseCapabilityFixture(fixture)).toThrow("live_evidence_required");
});

test("fixture evidence sources cannot be whitespace", () => {
  const fixture = fixtureInput("root-non-uuid");
  recordField(fixture, "evidence").source = " ";

  expect(() => parseCapabilityFixture(fixture)).toThrow("invalid_capability_fixture");
});
