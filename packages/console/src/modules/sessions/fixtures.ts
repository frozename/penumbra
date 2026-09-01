import type { SessionEvent, SessionNoteDraft } from "@penumbra/api-contract";

import type { SessionEventParseResult } from "@src/api/client";

const BASE_ISO = "2026-09-01T10:00:00.000Z";
const SESSION_ID = "session-story-123456";
const RELATED_SESSION_ID = "session-story-previous";
const REF_PATH = "/notes/continuity/session-2026-09-01.md";

export function makeStoryEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 1,
    session_id: SESSION_ID,
    related_session_id: null,
    project_id: "penumbra",
    cwd: "/Volumes/WorkSSD/repos/personal/penumbra",
    transcript_path: null,
    ref_path: REF_PATH,
    kind: "session.start",
    ts: BASE_ISO,
    meta: null,
    ...overrides,
  };
}

export function makeStoryDraft(overrides: Partial<SessionNoteDraft> = {}): SessionNoteDraft {
  return {
    draft_id: "draft-story-1",
    session_id: SESSION_ID,
    project_id: "penumbra",
    period_key: "2026-09-01-am",
    skeleton_path: "/notes/continuity/skeleton.md",
    draft_path: "/notes/continuity/session-2026-09-01-draft.md",
    note_path: REF_PATH,
    handoff_id: null,
    status: "awaiting_approval",
    composed_at: "2026-09-01T11:00:00.000Z",
    reviewed_at: null,
    composed_event_id: 2,
    review_event_id: null,
    ...overrides,
  };
}

export function makeStoryChain(): SessionEvent[] {
  return [
    makeStoryEvent({
      id: 1,
      kind: "continuity.skeleton_generated",
      ts: "2026-09-01T09:00:00.000Z",
      related_session_id: RELATED_SESSION_ID,
    }),
    makeStoryEvent({
      id: 2,
      kind: "continuity.draft_composed",
      ts: "2026-09-01T09:20:00.000Z",
      related_session_id: RELATED_SESSION_ID,
    }),
    makeStoryEvent({
      id: 3,
      kind: "continuity.draft_reviewed",
      ts: "2026-09-01T09:45:00.000Z",
      related_session_id: RELATED_SESSION_ID,
    }),
    makeStoryEvent({
      id: 4,
      kind: "continuity.boot_pickup",
      ts: "2026-09-01T10:15:00.000Z",
      related_session_id: RELATED_SESSION_ID,
    }),
    makeStoryEvent({
      id: 5,
      kind: "continuity.note_superseded",
      ts: "2026-09-01T10:40:00.000Z",
      related_session_id: RELATED_SESSION_ID,
    }),
  ];
}

export function parsedStoryEvents(events: SessionEvent[]): SessionEventParseResult[] {
  return events.map((event) => ({ ok: true, event }));
}
