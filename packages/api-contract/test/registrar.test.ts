import { describe, expect, test } from "bun:test";

import {
  RegistrarCreateRequestSchema,
  RegistrarEventInputSchema,
  RegistrarEventKindSchema,
  RegistrarEventSchema,
  RegistrarPhaseStatusSchema,
} from "../src/index.js";

const storedEvent = {
  event_id: 1,
  registrar_id: "registrar-1",
  phase_no: null,
  state: null,
  ref_event_id: null,
  link_kind: null,
  link_value: null,
  actor: "operator",
  body: "status update",
  created_at: 1_700_000_000,
};

describe("RegistrarEventSchema", () => {
  test("rejects an unknown kind", () => {
    expect(RegistrarEventSchema.safeParse({ ...storedEvent, kind: "sabotage" }).success).toBe(
      false,
    );
  });

  test("rejects stored events that violate kind-specific state and link invariants", () => {
    expect(
      RegistrarEventSchema.safeParse({ ...storedEvent, kind: "blocker", state: "owed" }).success,
    ).toBe(false);
    expect(
      RegistrarEventSchema.safeParse({ ...storedEvent, kind: "phase_transition", state: null })
        .success,
    ).toBe(false);
    expect(RegistrarEventSchema.safeParse({ ...storedEvent, kind: "link" }).success).toBe(false);
    expect(
      RegistrarEventSchema.safeParse({ ...storedEvent, kind: "blocker", state: "resolved" })
        .success,
    ).toBe(false);
  });
});

describe("RegistrarEventInputSchema", () => {
  const base = {
    actor: "operator" as const,
    body: "status update",
  };

  test("rejects kind='blocker' with no state, accepts state='opened'", () => {
    expect(RegistrarEventInputSchema.safeParse({ ...base, kind: "blocker" }).success).toBe(false);
    expect(
      RegistrarEventInputSchema.safeParse({ ...base, kind: "blocker", state: "opened" }).success,
    ).toBe(true);
  });

  test("rejects state='resolved' with no ref_event_id", () => {
    expect(
      RegistrarEventInputSchema.safeParse({ ...base, kind: "blocker", state: "resolved" }).success,
    ).toBe(false);
  });

  test("rejects kind='phase_transition' with no from_status", () => {
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        phase_no: 1,
        kind: "phase_transition",
        state: "complete",
      }).success,
    ).toBe(false);
  });

  test("accepts draft as an entry_transition source status by design", () => {
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "entry_transition",
        from_status: "draft",
        state: "active",
      }).success,
    ).toBe(true);
  });

  test("rejects draft as an entry_transition target status", () => {
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "entry_transition",
        from_status: "active",
        state: "draft",
      }).success,
    ).toBe(false);
  });
});

describe("RegistrarCreateRequestSchema", () => {
  const request = {
    title: "Registrar rollout",
    slug: "registrar-rollout",
    home_project: "penumbra",
    phases: ["Contract", "Core domain"],
  };

  test("strict() rejects an unknown field", () => {
    expect(RegistrarCreateRequestSchema.safeParse({ ...request, surprise: true }).success).toBe(
      false,
    );
  });

  test("rejects a body over 4096 bytes", () => {
    const body = "😀".repeat(1025);
    expect(
      RegistrarEventInputSchema.safeParse({
        actor: "operator",
        body,
        kind: "progress",
      }).success,
    ).toBe(false);
  });
});

describe("Registrar enum guards", () => {
  test("RegistrarPhaseStatusSchema options are unchanged", () => {
    expect(RegistrarPhaseStatusSchema.options).toEqual([
      "pending",
      "active",
      "blocked",
      "complete",
      "abandoned",
    ]);
  });

  test("RegistrarEventKindSchema options include entry_transition last", () => {
    expect(RegistrarEventKindSchema.options).toEqual([
      "progress",
      "caveat",
      "blocker",
      "follow_up",
      "decision",
      "phase_transition",
      "link",
      "entry_transition",
    ]);
  });
});
