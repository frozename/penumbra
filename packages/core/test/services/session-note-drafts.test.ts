import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import {
  type RegisterSessionNoteDraftInput,
  SessionNoteDrafts,
} from "@src/services/session-note-drafts.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function draftInput(
  overrides: Partial<RegisterSessionNoteDraftInput> = {},
): RegisterSessionNoteDraftInput {
  return {
    draft_id: "draft-1",
    session_id: "session-1",
    project_id: "project-1",
    period_key: "2026-08-31-pm",
    skeleton_path: "/tmp/maestro-continuation-2026-08-31-pm.skeleton.md",
    draft_path: "/tmp/maestro-continuation-2026-08-31-pm.draft.md",
    note_path: "/tmp/maestro-continuation-2026-08-31-pm.md",
    handoff_id: "handoff-1",
    composed_at: "2026-08-31T20:00:00.000Z",
    composed_event_id: 7,
    ...overrides,
  };
}

describe("SessionNoteDrafts", () => {
  let db: Database;
  let drafts: SessionNoteDrafts;

  beforeEach(() => {
    db = freshDb();
    drafts = new SessionNoteDrafts(db);
  });

  test("registerDraft stores a draft that get returns with awaiting_approval status", () => {
    const row = drafts.registerDraft(draftInput());

    expect(row).toMatchObject({
      draft_id: "draft-1",
      status: "awaiting_approval",
      reviewed_at: null,
      review_event_id: null,
    });
    expect(drafts.get("draft-1")).toEqual(row);
  });

  test("approve is CAS guarded and reports conflict on a second approval", () => {
    drafts.registerDraft(draftInput());

    const first = drafts.approve({
      draft_id: "draft-1",
      reviewed_at: "2026-08-31T20:05:00.000Z",
      review_event_id: 11,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.code);
    expect(first.draft.status).toBe("approved");
    expect(first.draft.reviewed_at).toBe("2026-08-31T20:05:00.000Z");
    expect(first.draft.review_event_id).toBe(11);

    const second = drafts.approve({
      draft_id: "draft-1",
      reviewed_at: "2026-08-31T20:06:00.000Z",
      review_event_id: 12,
    });
    expect(second).toEqual({ ok: false, code: "conflict" });
  });

  test("approve reports not_found for an unknown draft", () => {
    expect(
      drafts.approve({
        draft_id: "missing",
        reviewed_at: "2026-08-31T20:05:00.000Z",
        review_event_id: 11,
      }),
    ).toEqual({ ok: false, code: "not_found" });
  });

  test("revertApproval moves an unstamped approval back to awaiting_approval", () => {
    drafts.registerDraft(draftInput());
    const approved = drafts.approve({
      draft_id: "draft-1",
      reviewed_at: "2026-08-31T20:05:00.000Z",
      review_event_id: null,
    });
    expect(approved.ok).toBe(true);

    expect(drafts.revertApproval("draft-1")).toBe(true);

    expect(drafts.get("draft-1")).toMatchObject({
      status: "awaiting_approval",
      reviewed_at: null,
      review_event_id: null,
    });
  });

  test("revertApproval does not move a stamped review back to awaiting_approval", () => {
    drafts.registerDraft(draftInput());
    const approved = drafts.approve({
      draft_id: "draft-1",
      reviewed_at: "2026-08-31T20:05:00.000Z",
      review_event_id: 11,
    });
    expect(approved.ok).toBe(true);

    expect(drafts.revertApproval("draft-1")).toBe(false);

    expect(drafts.get("draft-1")).toMatchObject({
      status: "approved",
      reviewed_at: "2026-08-31T20:05:00.000Z",
      review_event_id: 11,
    });
  });

  test("list filters by status and respects the limit", () => {
    drafts.registerDraft(draftInput({ draft_id: "old", composed_at: "2026-08-31T20:00:00.000Z" }));
    drafts.registerDraft(draftInput({ draft_id: "new", composed_at: "2026-08-31T20:01:00.000Z" }));
    const approved = drafts.approve({
      draft_id: "old",
      reviewed_at: "2026-08-31T20:02:00.000Z",
      review_event_id: 3,
    });
    expect(approved.ok).toBe(true);

    expect(
      drafts.list({ status: "awaiting_approval", limit: 1 }).map((draft) => draft.draft_id),
    ).toEqual(["new"]);
  });
});
