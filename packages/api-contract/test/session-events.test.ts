import { describe, expect, it } from "bun:test";

import { SessionEventKindSchema, SessionEventSchema } from "../src/session-events.js";

describe("session event contract", () => {
  it("SessionEventKindSchema enumerates exactly the 9 kinds and rejects a 10th", () => {
    expect(SessionEventKindSchema.options).toEqual([
      "session.start",
      "session.stop",
      "session.pre_compact",
      "session.end",
      "continuity.skeleton_generated",
      "continuity.draft_composed",
      "continuity.draft_reviewed",
      "continuity.note_superseded",
      "continuity.boot_pickup",
    ]);
    expect(SessionEventKindSchema.safeParse("continuity.unknown").success).toBe(false);
  });

  it("a continuity.boot_pickup row round-trips with related_session_id populated", () => {
    const parsed = SessionEventSchema.parse({
      session_id: "s-new",
      related_session_id: "s-old",
      project_id: "proj",
      cwd: "/repo",
      transcript_path: "/tmp/transcript.jsonl",
      ref_path: "/tmp/note.md",
      kind: "continuity.boot_pickup",
      ts: "2026-05-01T00:00:00.000Z",
      meta: { first_moves: ["inspect"] },
    });

    expect(parsed.related_session_id).toBe("s-old");
    expect(parsed.kind).toBe("continuity.boot_pickup");
  });

  it("a session event with session_id null round-trips SessionEventSchema", () => {
    const parsed = SessionEventSchema.parse({
      session_id: null,
      related_session_id: null,
      project_id: "proj",
      cwd: "/repo",
      transcript_path: null,
      ref_path: null,
      kind: "session.stop",
      ts: "2026-05-01T00:00:00.000Z",
      meta: null,
    });

    expect(parsed.session_id).toBeNull();
  });

  it("the schema is .loose() -- an unknown forward-compatible field does not throw", () => {
    const parsed = SessionEventSchema.parse({
      session_id: "s-1",
      related_session_id: null,
      project_id: null,
      cwd: null,
      transcript_path: null,
      ref_path: null,
      kind: "session.start",
      ts: "2026-05-01T00:00:00.000Z",
      meta: null,
      future_field: true,
    });

    expect(parsed.future_field).toBe(true);
  });
});
