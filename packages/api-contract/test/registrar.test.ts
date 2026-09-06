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

  test("accepts link_kind/link_value on non-link event kinds", () => {
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "follow_up",
        state: "done",
        ref_event_id: 3,
        link_kind: "commit_sha",
        link_value: "feec0a0e",
      }).success,
    ).toBe(true);
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "progress",
        link_kind: "memory_id",
        link_value: "7b8f6f8e-0000-4000-8000-000000000000",
      }).success,
    ).toBe(true);
  });

  test("rejects link_kind without link_value and vice versa", () => {
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "progress",
        link_kind: "commit_sha",
      }).success,
    ).toBe(false);
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "follow_up",
        state: "owed",
        link_value: "feec0a0e",
      }).success,
    ).toBe(false);
  });

  test("rejects a link_kind outside the storage enum", () => {
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "progress",
        link_kind: "anything_i_want",
        link_value: "feec0a0e",
      }).success,
    ).toBe(false);
  });

  test("kind='link' still requires both link fields", () => {
    expect(
      RegistrarEventInputSchema.safeParse({ ...base, kind: "link", link_kind: "commit_sha" })
        .success,
    ).toBe(false);
    expect(
      RegistrarEventInputSchema.safeParse({
        ...base,
        kind: "link",
        link_kind: "commit_sha",
        link_value: "feec0a0e",
      }).success,
    ).toBe(true);
  });

  test("done/dropped follow_ups still require ref_event_id, link fields notwithstanding", () => {
    for (const state of ["done", "dropped"] as const) {
      expect(
        RegistrarEventInputSchema.safeParse({ ...base, kind: "follow_up", state }).success,
      ).toBe(false);
      expect(
        RegistrarEventInputSchema.safeParse({
          ...base,
          kind: "follow_up",
          state,
          link_kind: "commit_sha",
          link_value: "feec0a0e",
        }).success,
      ).toBe(false);
    }
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
