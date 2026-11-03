// Production mutations that would make these tests fail:
// 1. Remove SessionNoteDraftStatusSchema enum values (awaiting_approval/approved/edited/rejected)
// 2. Remove .nullable() from session_id/project_id/handoff_id/reviewed_at/composed_event_id/review_event_id
// 3. Remove .min(1) from draft_id/period_key/skeleton_path/draft_path/note_path/composed_at
// 4. Remove .int() from composed_event_id/review_event_id
// 5. Remove .strict() from SessionNoteDraftsQuerySchema
// 6. Remove .coerce/ .int() / .positive() / .max(500) from limit
// 7. Change SessionNoteApproveRequestSchema from z.literal(true) to z.boolean()
// 8. Remove .nullable() from SessionNoteApproveResponseSchema.event
// 9. Remove .min(1) from SessionNoteApproveRequestSchema.draft_id
import { describe, expect, test } from "bun:test";

import {
  SessionNoteApproveRequestSchema,
  SessionNoteApproveResponseSchema,
  SessionNoteDraftSchema,
  SessionNoteDraftsListResponseSchema,
  SessionNoteDraftsQuerySchema,
  SessionNoteDraftStatusSchema,
} from "../src/index.js";

describe("SessionNoteDraftStatusSchema", () => {
  test("accepts exactly awaiting_approval / approved / edited / rejected", () => {
    expect(SessionNoteDraftStatusSchema.safeParse("awaiting_approval").success).toBe(true);
    expect(SessionNoteDraftStatusSchema.safeParse("approved").success).toBe(true);
    expect(SessionNoteDraftStatusSchema.safeParse("edited").success).toBe(true);
    expect(SessionNoteDraftStatusSchema.safeParse("rejected").success).toBe(true);
  });

  test("rejects unknown values like 'pending'", () => {
    expect(SessionNoteDraftStatusSchema.safeParse("pending").success).toBe(false);
    expect(SessionNoteDraftStatusSchema.safeParse("draft").success).toBe(false);
  });
});

describe("SessionNoteDraftSchema", () => {
  const validFixture = {
    draft_id: "d-1",
    session_id: "s-1",
    project_id: "p-1",
    period_key: "2026-01",
    skeleton_path: "/plans/skeleton.md",
    draft_path: "/plans/draft.md",
    note_path: "/plans/MEMORY.md",
    handoff_id: "h-1",
    status: "awaiting_approval" as const,
    composed_at: "2026-01-01T00:00:00Z",
    reviewed_at: "2026-01-02T00:00:00Z",
    composed_event_id: 1,
    review_event_id: 2,
  };

  test("full valid fixture parses", () => {
    const parsed = SessionNoteDraftSchema.parse(validFixture);
    expect(parsed.draft_id).toBe("d-1");
  });

  test("nullable fields accept null", () => {
    const partial = {
      ...validFixture,
      session_id: null,
      project_id: null,
      handoff_id: null,
      reviewed_at: null,
      composed_event_id: null,
      review_event_id: null,
    };
    expect(SessionNoteDraftSchema.safeParse(partial).success).toBe(true);
  });

  test("omitting session_id (required) fails", () => {
    const omit: Record<string, unknown> = { ...validFixture };
    delete omit.session_id;
    expect(SessionNoteDraftSchema.safeParse(omit).success).toBe(false);
  });

  test("empty strings fail for draft_id/period_key/skeleton_path/draft_path/note_path/composed_at", () => {
    expect(SessionNoteDraftSchema.safeParse({ ...validFixture, draft_id: "" }).success).toBe(false);
    expect(SessionNoteDraftSchema.safeParse({ ...validFixture, period_key: "" }).success).toBe(
      false,
    );
    expect(SessionNoteDraftSchema.safeParse({ ...validFixture, skeleton_path: "" }).success).toBe(
      false,
    );
    expect(SessionNoteDraftSchema.safeParse({ ...validFixture, draft_path: "" }).success).toBe(
      false,
    );
    expect(SessionNoteDraftSchema.safeParse({ ...validFixture, note_path: "" }).success).toBe(
      false,
    );
    expect(SessionNoteDraftSchema.safeParse({ ...validFixture, composed_at: "" }).success).toBe(
      false,
    );
  });

  test("composed_event_id 1.5 fails (must be int)", () => {
    expect(
      SessionNoteDraftSchema.safeParse({ ...validFixture, composed_event_id: 1.5 }).success,
    ).toBe(false);
  });

  test("review_event_id 1.5 fails (must be int)", () => {
    expect(
      SessionNoteDraftSchema.safeParse({ ...validFixture, review_event_id: 1.5 }).success,
    ).toBe(false);
  });

  test("object is non-strict: extra keys are stripped from .data", () => {
    const withExtra = { ...validFixture, extra_field: "ignored" };
    const parsed = SessionNoteDraftSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("extra_field");
    }
  });
});

describe("SessionNoteDraftsQuerySchema", () => {
  test("empty object ok", () => {
    expect(SessionNoteDraftsQuerySchema.safeParse({}).success).toBe(true);
  });

  test("limit coercion: '25' gives data.limit === 25 (number)", () => {
    const parsed = SessionNoteDraftsQuerySchema.parse({ limit: "25" });
    expect(parsed.limit).toBe(25);
    expect(typeof parsed.limit).toBe("number");
  });

  test("limit: '500' ok, '501' fails, '0' fails, '-1' fails, '1.5' fails, 'abc' fails", () => {
    expect(SessionNoteDraftsQuerySchema.safeParse({ limit: "500" }).success).toBe(true);
    expect(SessionNoteDraftsQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(SessionNoteDraftsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(SessionNoteDraftsQuerySchema.safeParse({ limit: "-1" }).success).toBe(false);
    expect(SessionNoteDraftsQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
    expect(SessionNoteDraftsQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  test("status must be a valid enum value", () => {
    expect(SessionNoteDraftsQuerySchema.safeParse({ status: "approved" }).success).toBe(true);
    expect(SessionNoteDraftsQuerySchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  test("unknown key fails as unrecognized_keys (strict)", () => {
    const result = SessionNoteDraftsQuerySchema.safeParse({ lmit: "5" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const code = result.error.issues[0]?.code;
      expect(code).toBe("unrecognized_keys");
    }
  });
});

describe("SessionNoteApproveRequestSchema", () => {
  test("{draft_id:'d1', approve:true} ok", () => {
    expect(
      SessionNoteApproveRequestSchema.safeParse({ draft_id: "d1", approve: true }).success,
    ).toBe(true);
  });

  test("with body:'x' and overwrite:true ok", () => {
    expect(
      SessionNoteApproveRequestSchema.safeParse({
        draft_id: "d1",
        approve: true,
        body: "x",
        overwrite: true,
      }).success,
    ).toBe(true);
  });

  test("approve:false fails", () => {
    expect(
      SessionNoteApproveRequestSchema.safeParse({ draft_id: "d1", approve: false }).success,
    ).toBe(false);
  });

  test("approve missing fails", () => {
    expect(SessionNoteApproveRequestSchema.safeParse({ draft_id: "d1" }).success).toBe(false);
  });

  test("approve:'true' fails (must be literal true)", () => {
    expect(
      SessionNoteApproveRequestSchema.safeParse({ draft_id: "d1", approve: "true" }).success,
    ).toBe(false);
  });

  test("draft_id:'' fails", () => {
    expect(SessionNoteApproveRequestSchema.safeParse({ draft_id: "", approve: true }).success).toBe(
      false,
    );
  });

  test("unknown key fails as unrecognized_keys", () => {
    const result = SessionNoteApproveRequestSchema.safeParse({
      draft_id: "d1",
      approve: true,
      unknown_key: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const code = result.error.issues[0]?.code;
      expect(code).toBe("unrecognized_keys");
    }
  });

  test("overwrite:'yes' fails", () => {
    expect(
      SessionNoteApproveRequestSchema.safeParse({ draft_id: "d1", approve: true, overwrite: "yes" })
        .success,
    ).toBe(false);
  });
});

describe("SessionNoteDraftsListResponseSchema", () => {
  test("{drafts:[]} ok", () => {
    expect(SessionNoteDraftsListResponseSchema.safeParse({ drafts: [] }).success).toBe(true);
  });

  test("{} fails (drafts required)", () => {
    expect(SessionNoteDraftsListResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("SessionNoteApproveResponseSchema", () => {
  const fixture = {
    draft_id: "d-1",
    session_id: null,
    project_id: null,
    period_key: "2026-01",
    skeleton_path: "/s.md",
    draft_path: "/d.md",
    note_path: "/n.md",
    handoff_id: null,
    status: "awaiting_approval" as const,
    composed_at: "2026-01-01T00:00:00Z",
    reviewed_at: null,
    composed_event_id: null,
    review_event_id: null,
  };

  test("{draft:<fixture>, event:null} ok", () => {
    expect(
      SessionNoteApproveResponseSchema.safeParse({ draft: fixture, event: null }).success,
    ).toBe(true);
  });

  test("missing event fails", () => {
    expect(SessionNoteApproveResponseSchema.safeParse({ draft: fixture }).success).toBe(false);
  });
});
