import { describe, expect, test } from "bun:test";

import {
  evaluateRound,
  type PendingRoundResult,
  type ProbeFixtureEvent,
  type ProbeProcessResult,
  type ProbeRunOptions,
  type SerializedDispatchEvidence,
} from "./devin-contention-probe-evidence.js";

function baseOptions(overrides: Partial<ProbeRunOptions> = {}): ProbeRunOptions {
  return {
    args: ["fake-acp"],
    binary: process.execPath,
    concurrency: 2,
    dbPath: "/tmp/devin-contention-probe-test.sqlite",
    minOverlap: 1,
    requireOverlap: true,
    rounds: 1,
    sqliteLockControlMs: 0,
    ...overrides,
  };
}

function processResult(
  index: number,
  sessionNewSendAt: number,
  sessionNewResponseAt: number,
): ProbeProcessResult {
  return {
    endAt: sessionNewResponseAt,
    error: null,
    exitCode: null,
    index,
    pid: 1000 + index,
    sessionId: `fake-session-${String(index)}`,
    sessionNewResponseAt,
    sessionNewSendAt,
    startAt: sessionNewSendAt - 10,
    stderrTail: "",
  };
}

function fixtureEvent(
  index: number,
  kind: "session_new_received" | "session_new_responding",
  atMs: number,
): ProbeFixtureEvent {
  return {
    atMs,
    kind,
    pid: 1000 + index,
    round: 1,
    sessionId: `fake-session-${String(index)}`,
  };
}

function baseRound(overrides: Partial<PendingRoundResult> = {}): PendingRoundResult {
  return {
    fixtureEvents: [
      fixtureEvent(0, "session_new_received", 1000),
      fixtureEvent(1, "session_new_received", 1010),
      fixtureEvent(0, "session_new_responding", 1300),
      fixtureEvent(1, "session_new_responding", 1310),
    ],
    lockControl: null,
    lockFreeControl: null,
    maxSendSkewMs: 0,
    postDb: {
      integrityCheck: "ok",
      journalMode: "delete",
      sessionsRowCount: 2,
      walBytes: 0,
    },
    preDb: {
      integrityCheck: "ok",
      journalMode: "delete",
      sessionsRowCount: 0,
      walBytes: 0,
    },
    processes: [processResult(0, 1000, 1400), processResult(1, 1200, 1400)],
    round: 1,
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      sqliteSetlkTimeout: false,
      sqliteVersion: "test",
    },
    ...overrides,
  };
}

function expectOnlySerializedPredicate(
  evidence: SerializedDispatchEvidence,
  firedPredicate: keyof SerializedDispatchEvidence,
): void {
  for (const predicate of [
    "sendSkew",
    "intervalOverlap",
    "receivedSkew",
    "respondingSkew",
  ] as const) {
    expect(evidence[predicate].fired).toBe(predicate === firedPredicate);
  }
}

describe("devin-contention-probe evidence", () => {
  test("classifies serialized dispatch from send skew alone", () => {
    const result = evaluateRound(baseRound({ maxSendSkewMs: 200 }), baseOptions(), null);

    expect(result.serializedDispatch.sendSkew.fired).toBe(true);
    expect(result.serializedDispatch.sendSkew.measurement).toBe(200);
    expectOnlySerializedPredicate(result.serializedDispatch, "sendSkew");
    expect(result.classifications).toContain("serialized_dispatch");
    expect(result.classifications).toEqual(["serialized_dispatch"]);
  });

  test("classifies serialized dispatch from interval overlap alone", () => {
    const result = evaluateRound(baseRound(), baseOptions({ minOverlap: 3 }), null);

    expect(result.serializedDispatch.intervalOverlap.fired).toBe(true);
    expect(result.serializedDispatch.intervalOverlap.measurement).toBe(2);
    expectOnlySerializedPredicate(result.serializedDispatch, "intervalOverlap");
    expect(result.classifications).toContain("serialized_dispatch");
    expect(result.classifications).toEqual(["serialized_dispatch"]);
  });

  test("classifies serialized dispatch from received skew alone", () => {
    const result = evaluateRound(
      baseRound({
        fixtureEvents: [
          fixtureEvent(0, "session_new_received", 1000),
          fixtureEvent(1, "session_new_received", 1120),
          fixtureEvent(0, "session_new_responding", 1300),
          fixtureEvent(1, "session_new_responding", 1310),
        ],
      }),
      baseOptions(),
      null,
    );

    expect(result.serializedDispatch.receivedSkew.fired).toBe(true);
    expect(result.serializedDispatch.receivedSkew.measurement).toBe(120);
    expectOnlySerializedPredicate(result.serializedDispatch, "receivedSkew");
    expect(result.classifications).toContain("serialized_dispatch");
    expect(result.classifications).toEqual(["serialized_dispatch"]);
  });
});
