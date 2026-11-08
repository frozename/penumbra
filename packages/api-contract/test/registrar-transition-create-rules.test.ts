import { describe, expect, test } from "bun:test";

import {
  RegistrarCreateRequestSchema,
  RegistrarEventInputSchema,
  RegistrarEventSchema,
} from "../src/index.js";

const inputBase = {
  actor: "operator" as const,
  body: "status update",
};

const storedBase = {
  event_id: 1,
  registrar_id: "registrar-1",
  phase_no: null,
  state: null,
  ref_event_id: null,
  link_kind: null,
  link_value: null,
  actor: "operator" as const,
  body: "status update",
  created_at: 1_700_000_000,
};

const createBase = {
  title: "Registrar rollout",
  slug: "registrar-rollout",
  home_project: "penumbra",
  phases: ["Contract"],
};

describe("RegistrarEventInputSchema", () => {
  test("entry_transition rejects state equal to from_status with a state-path issue", () => {
    const rejected = RegistrarEventInputSchema.safeParse({
      ...inputBase,
      kind: "entry_transition",
      from_status: "active",
      state: "active",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["state"]]);

    const accepted = RegistrarEventInputSchema.safeParse({
      ...inputBase,
      kind: "entry_transition",
      from_status: "paused",
      state: "active",
    });
    expect(accepted.success).toBe(true);
  });

  test("phase_transition requires phase_no even though other kinds treat it as optional", () => {
    const rejected = RegistrarEventInputSchema.safeParse({
      ...inputBase,
      kind: "phase_transition",
      from_status: "active",
      state: "complete",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["phase_no"]]);

    const accepted = RegistrarEventInputSchema.safeParse({
      ...inputBase,
      kind: "phase_transition",
      phase_no: 1,
      from_status: "active",
      state: "complete",
    });
    expect(accepted.success).toBe(true);
  });

  test("body of exactly 4096 bytes is accepted", () => {
    const accepted = RegistrarEventInputSchema.safeParse({
      ...inputBase,
      kind: "progress",
      body: "\u{1F600}".repeat(1024),
    });
    expect(accepted.success).toBe(true);
  });

  test("owed follow_up does not require ref_event_id", () => {
    const accepted = RegistrarEventInputSchema.safeParse({
      ...inputBase,
      kind: "follow_up",
      state: "owed",
    });
    expect(accepted.success).toBe(true);
  });
});

describe("RegistrarEventSchema", () => {
  test("non-lifecycle kind rejects a non-null state", () => {
    const rejected = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "progress",
      state: "opened",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["state"]]);

    const accepted = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "progress",
      state: null,
    });
    expect(accepted.success).toBe(true);
  });

  test("entry_transition rejects a phase-only status", () => {
    const rejected = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "entry_transition",
      state: "pending",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["state"]]);

    const accepted = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "entry_transition",
      state: "paused",
    });
    expect(accepted.success).toBe(true);
  });

  test("phase_transition rejects an entry-only status", () => {
    const rejected = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "phase_transition",
      phase_no: 1,
      state: "paused",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["state"]]);

    const accepted = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "phase_transition",
      phase_no: 1,
      state: "blocked",
    });
    expect(accepted.success).toBe(true);
  });

  test("done follow_up row requires ref_event_id", () => {
    const rejected = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "follow_up",
      state: "done",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["ref_event_id"]]);

    const accepted = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "follow_up",
      state: "done",
      ref_event_id: 2,
    });
    expect(accepted.success).toBe(true);
  });

  test("link row with link_kind but null link_value reports the link_value path", () => {
    const rejected = RegistrarEventSchema.safeParse({
      ...storedBase,
      kind: "link",
      link_kind: "commit_sha",
      link_value: null,
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["link_value"]]);
  });
});

describe("RegistrarCreateRequestSchema", () => {
  test("status defaults to active when omitted", () => {
    expect(RegistrarCreateRequestSchema.parse(createBase).status).toBe("active");
  });

  test("slug rejects uppercase letters", () => {
    const rejected = RegistrarCreateRequestSchema.safeParse({
      ...createBase,
      slug: "Registrar-rollout",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["slug"]]);
  });

  test("slug rejects a leading digit", () => {
    const rejected = RegistrarCreateRequestSchema.safeParse({
      ...createBase,
      slug: "1registrar",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["slug"]]);
  });

  test("phases must be non-empty", () => {
    const rejected = RegistrarCreateRequestSchema.safeParse({
      ...createBase,
      phases: [],
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["phases"]]);
  });

  test("source_doc_path rejects an empty string", () => {
    const rejected = RegistrarCreateRequestSchema.safeParse({
      ...createBase,
      source_doc_path: "",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((i) => i.path)).toEqual([["source_doc_path"]]);
  });
});
