import { assertHookOutput, parseCapabilityFixture } from "@harness-parity/capability-contract.js";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type CodexHookLaunchContext,
  normalizeCodexHook,
  renderCodexHookOutput,
} from "@src/commands/codex-hook-contract.js";

type InputCase = { name: string; fixture: unknown; valid: boolean; expectedError: string | null };
type OutputCase = { event: string; output: unknown; valid: boolean };

const cases = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../fixtures/codex-hooks/contract-cases.json"), "utf8"),
) as {
  fixtureVersion: number;
  releaseReference: { fetchedAt: string };
  inputs: InputCase[];
  outputs: OutputCase[];
};

const trustedLaunch: CodexHookLaunchContext = {
  role: "maestro",
  rootSessionId: "thr_contract_root",
  provenance: "verified-session-correlation",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixtureInput(name: string): Record<string, unknown> {
  const row = cases.inputs.find((candidate) => candidate.name === name);
  if (!row || !isRecord(row.fixture)) throw new Error(`missing fixture: ${name}`);
  const parsed = parseCapabilityFixture(row.fixture);
  if (!parsed.input) throw new Error(`fixture has no input: ${name}`);
  return structuredClone(parsed.input);
}

function fixture(name: string): Record<string, unknown> {
  const row = cases.inputs.find((candidate) => candidate.name === name);
  if (!row || !isRecord(row.fixture)) throw new Error(`missing fixture: ${name}`);
  return structuredClone(row.fixture);
}

function fixtureInputFrom(rawFixture: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseCapabilityFixture(rawFixture);
  if (!parsed.input) throw new Error("fixture has no input");
  return structuredClone(parsed.input);
}

test("root admission requires trusted correlation and subagent events retain parent context", () => {
  const launch: CodexHookLaunchContext = {
    role: "maestro",
    rootSessionId: "opaque-root",
    provenance: "verified-session-correlation",
  };
  const root = normalizeCodexHook(
    {
      hook_event_name: "SessionStart",
      session_id: "opaque-root",
      cwd: "/repo",
      transcript_path: null,
      model: "gpt-5.6-terra",
      permission_mode: "default",
      source: "startup",
    },
    launch,
  );
  const child = normalizeCodexHook(
    {
      hook_event_name: "SubagentStart",
      session_id: "opaque-root",
      cwd: "/repo",
      transcript_path: null,
      model: "gpt-5.6-terra",
      permission_mode: "default",
      turn_id: "turn-child",
      agent_id: "agent-a",
      agent_type: "worker",
    },
    launch,
  );
  const ambiguous = normalizeCodexHook(
    {
      hook_event_name: "SessionStart",
      session_id: "opaque-root",
      cwd: "/repo",
      transcript_path: null,
      model: "gpt-5.6-terra",
      permission_mode: "default",
      source: "startup",
    },
    { role: "maestro", rootSessionId: null, provenance: "unknown" },
  );
  expect(root?.sessionId).toBe("opaque-root");
  expect(root?.lineage).toBe("root");
  expect(root?.actionableLifecycle).toBe(true);
  expect(child?.sessionId).toBeNull();
  expect(child?.parentSessionId).toBe("opaque-root");
  expect(child?.agentId).toBe("agent-a");
  expect(child?.agentType).toBe("worker");
  expect(child?.lineage).toBe("child");
  expect(child?.actionableLifecycle).toBe(false);
  expect(ambiguous?.role).toBe("unknown");
  expect(ambiguous?.lineage).toBe("unknown");
  expect(ambiguous?.actionableLifecycle).toBe(false);
});

test("Stop advisory is JSON and never asks for another turn", () => {
  const output: unknown = JSON.parse(renderCodexHookOutput("Stop", "Dispatch remaining work"));
  expect(output).toEqual({});
  if (!isRecord(output)) throw new Error("rendered output was not an object");
  expect(output.decision).toBeUndefined();
});

test("normalized fixtures round-trip through the observed CLI contract and output parser", () => {
  expect(cases.fixtureVersion).toBe(1);
  expect(cases.releaseReference.fetchedAt).toBe("2026-09-10");

  const root = normalizeCodexHook(fixtureInput("root-non-uuid"), trustedLaunch);
  expect(root).toMatchObject({
    harness: "codex",
    role: "maestro",
    lineage: "root",
    provenance: "verified-session-correlation",
    sessionId: "thr_contract_root",
    parentSessionId: null,
    event: "SessionStart",
    cwd: "/fixture/project-a",
    transcriptPath: null,
    transcriptFormat: null,
    source: "startup",
    toolActivity: "other",
    actionableLifecycle: true,
  });

  const stop = normalizeCodexHook(fixtureInput("repeated-stop-second"), trustedLaunch);
  expect(stop?.lineage).toBe("root");
  expect(stop?.actionableLifecycle).toBe(false);

  const child = normalizeCodexHook(fixtureInput("child"), trustedLaunch);
  expect(child).toMatchObject({
    lineage: "child",
    sessionId: null,
    parentSessionId: "thr_contract_root",
    agentId: "agent_fixture_child",
    agentType: "fixture-child",
    isChild: true,
    actionableLifecycle: false,
  });

  for (const row of cases.outputs) {
    const rendered = renderCodexHookOutput(row.event, "fixture recall");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(() => {
      assertHookOutput(row.event, JSON.parse(rendered));
    }).not.toThrow();
  }
});

test("consumer-accepted optional nullable child transcript field round-trips without actionability", () => {
  const childFixture = fixture("child");
  const input = childFixture.input;
  if (!isRecord(input)) throw new Error("child fixture input missing");
  delete input.agent_transcript_path;

  const parsedInput = fixtureInputFrom(childFixture);
  const normalized = normalizeCodexHook(parsedInput, trustedLaunch);

  expect(normalized).toMatchObject({
    event: "SubagentStop",
    lineage: "child",
    sessionId: null,
    parentSessionId: "thr_contract_root",
    agentId: "agent_fixture_child",
    agentType: "fixture-child",
    actionableLifecycle: false,
  });
});

test("Stop and SubagentStop last_assistant_message follows optional nullable host contract", () => {
  for (const name of ["ordinary-stop", "child"]) {
    const expectedEvent = name === "ordinary-stop" ? "Stop" : "SubagentStop";
    const withoutMessage = fixture(name);
    const input = withoutMessage.input;
    if (!isRecord(input)) throw new Error(`${name} fixture input missing`);
    delete input.last_assistant_message;
    expect(normalizeCodexHook(fixtureInputFrom(withoutMessage), trustedLaunch)?.event).toBe(
      expectedEvent,
    );

    const nullMessage = fixtureInput(name);
    nullMessage.last_assistant_message = null;
    expect(normalizeCodexHook(nullMessage, trustedLaunch)?.event).toBe(expectedEvent);

    const stringMessage = fixtureInput(name);
    stringMessage.last_assistant_message = "completed";
    expect(normalizeCodexHook(stringMessage, trustedLaunch)?.event).toBe(expectedEvent);

    for (const badValue of [123, { text: "completed" }, "x".repeat(8193)]) {
      const malformed = fixtureInput(name);
      malformed.last_assistant_message = badValue;
      expect(normalizeCodexHook(malformed, trustedLaunch)).toBeNull();
    }
  }
});

test("SubagentStop rejects malformed optional transcript path values", () => {
  const child = fixtureInput("child");
  delete child.agent_transcript_path;
  expect(normalizeCodexHook(child, trustedLaunch)?.event).toBe("SubagentStop");

  const nullTranscript = fixtureInput("child");
  nullTranscript.agent_transcript_path = null;
  expect(normalizeCodexHook(nullTranscript, trustedLaunch)?.event).toBe("SubagentStop");

  const stringTranscript = fixtureInput("child");
  stringTranscript.agent_transcript_path = "/tmp/agent.jsonl";
  expect(normalizeCodexHook(stringTranscript, trustedLaunch)?.event).toBe("SubagentStop");

  for (const badValue of [123, { path: "/tmp/agent.jsonl" }, "x".repeat(8193)]) {
    const malformed = fixtureInput("child");
    malformed.agent_transcript_path = badValue;
    expect(normalizeCodexHook(malformed, trustedLaunch)).toBeNull();
  }
});

test("event matrix preserves raw identity without promoting malformed or ambiguous fields", () => {
  const rows = [
    ["resume", "SessionStart", "root", true],
    ["compact", "SessionStart", "root", true],
    ["clear", "SessionStart", "root", true],
    ["ordinary-stop", "Stop", "root", true],
    ["precompact", "PreCompact", "root", true],
    ["session-end", "SessionEnd", "root", true],
    ["tool-set-pre-bash", "PreToolUse", "root", true],
    ["tool-set-post-apply-patch", "PostToolUse", "root", true],
    ["tool-set-post-mcp", "PostToolUse", "root", true],
    ["tool-set-deferred-bash-post", "PostToolUse", "root", true],
  ] as const;

  for (const [name, event, lineage, actionable] of rows) {
    const normalized = normalizeCodexHook(fixtureInput(name), trustedLaunch);
    expect(normalized?.event).toBe(event);
    expect(normalized?.lineage).toBe(lineage);
    expect(normalized?.transcriptFormat).toBeNull();
    expect(normalized?.actionableLifecycle).toBe(actionable);
  }

  expect(
    normalizeCodexHook(
      { hook_event_name: "SessionStart", session_id: "", cwd: "/repo" },
      trustedLaunch,
    ),
  ).toBeNull();
  expect(
    normalizeCodexHook({ hook_event_name: "SessionStart", session_id: "root" }, trustedLaunch),
  ).toBeNull();
  const nullTranscriptFormat = fixtureInput("root-non-uuid");
  nullTranscriptFormat.transcript_format = null;
  expect(normalizeCodexHook(nullTranscriptFormat, trustedLaunch)?.transcriptFormat).toBeNull();
  expect(
    normalizeCodexHook(
      {
        hook_event_name: "SessionStart",
        session_id: "root",
        cwd: "x".repeat(8193),
        transcript_path: null,
        model: "gpt-5.6-terra",
        permission_mode: "default",
        source: "startup",
      },
      { role: "maestro", rootSessionId: "root", provenance: "verified-launch" },
    ),
  ).toBeNull();

  const missingTranscript = fixtureInput("root-non-uuid");
  delete missingTranscript.transcript_path;
  expect(normalizeCodexHook(missingTranscript, trustedLaunch)).toBeNull();

  const missingModel = fixtureInput("root-non-uuid");
  delete missingModel.model;
  expect(normalizeCodexHook(missingModel, trustedLaunch)).toBeNull();

  const invalidSource = fixtureInput("root-non-uuid");
  invalidSource.source = "restored-from-backup";
  expect(normalizeCodexHook(invalidSource, trustedLaunch)).toBeNull();
});

test("adapter rejects fixture inputs that the pinned consumer rejects for unknown fields", () => {
  for (const [field, value] of [
    ["transcript_format", "jsonl"],
    ["caller_role", "maestro"],
    ["role", "root"],
    ["provenance", "verified-launch"],
    ["delivery_id", "delivery-1"],
    ["hook_delivery_id", "delivery-2"],
    ["id", "delivery-3"],
  ] as const) {
    const rawFixture = fixture("root-non-uuid");
    const input = rawFixture.input;
    if (!isRecord(input)) throw new Error("root fixture input missing");
    input[field] = value;

    expect(() => parseCapabilityFixture(rawFixture)).toThrow("unsupported_hook_input_field");
    expect(normalizeCodexHook(input, trustedLaunch)).toBeNull();
  }
});

test("tool classification uses structured tool fields only", () => {
  expect(
    normalizeCodexHook(fixtureInput("tool-set-post-apply-patch"), trustedLaunch)?.toolActivity,
  ).toBe("edit");
  expect(normalizeCodexHook(fixtureInput("tool-set-pre-bash"), trustedLaunch)?.toolActivity).toBe(
    "shell",
  );
  expect(
    normalizeCodexHook(fixtureInput("tool-set-deferred-bash-post"), trustedLaunch)?.toolActivity,
  ).toBe("shell");
  expect(normalizeCodexHook(fixtureInput("tool-set-post-mcp"), trustedLaunch)?.toolActivity).toBe(
    "other",
  );

  const nestedTextOnly = normalizeCodexHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "thr_contract_root",
      cwd: "/fixture/project-a",
      transcript_path: null,
      model: "gpt-5.6-terra",
      permission_mode: "default",
      turn_id: "turn-tool-2",
      tool_name: "Bash",
      tool_use_id: "tool-bash-2",
      tool_input: { command: "bun mcp__penumbra__chain_start" },
      tool_response: { exit_code: 0, output: "mcp__penumbra__memory_observe" },
    },
    trustedLaunch,
  );
  expect(nestedTextOnly?.toolActivity).toBe("shell");
  expect(nestedTextOnly?.rawToolInput).toEqual({ command: "bun mcp__penumbra__chain_start" });

  const structuredDispatch = normalizeCodexHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "thr_contract_root",
      cwd: "/fixture/project-a",
      transcript_path: null,
      model: "gpt-5.6-terra",
      permission_mode: "default",
      turn_id: "turn-tool-3",
      tool_name: "mcp__penumbra__chain_start",
      tool_use_id: "tool-mcp-2",
      tool_input: { task_type: "implement_small" },
    },
    trustedLaunch,
  );
  expect(structuredDispatch?.toolActivity).toBe("fleet-dispatch");

  const structuredObserve = normalizeCodexHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "thr_contract_root",
      cwd: "/fixture/project-a",
      transcript_path: null,
      model: "gpt-5.6-terra",
      permission_mode: "default",
      turn_id: "turn-tool-4",
      tool_name: "mcp__penumbra__memory_observe",
      tool_use_id: "tool-mcp-3",
      tool_input: { note: "fixture" },
    },
    trustedLaunch,
  );
  expect(structuredObserve?.toolActivity).toBe("mcp-observe");

  for (const toolInput of [
    { session_id: 123 },
    { session_id: "shell-session" },
    { sessionId: "shell-session" },
    {},
  ]) {
    const writeStdin = normalizeCodexHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "thr_contract_root",
        cwd: "/fixture/project-a",
        transcript_path: null,
        model: "gpt-5.6-terra",
        permission_mode: "default",
        turn_id: "turn-tool-5",
        tool_name: "write_stdin",
        tool_use_id: "tool-stdin-1",
        tool_input: toolInput,
        tool_response: { output: "Process exited with code 0" },
      },
      trustedLaunch,
    );
    expect(writeStdin?.toolActivity).toBe("other");
  }
});
