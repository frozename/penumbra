import type { SessionNoteApproveResponse } from "@penumbra/api-contract";

import { expect, test } from "bun:test";
import { ZodError } from "zod";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  sessionNoteApproveHandler,
  SessionNoteApproveInputSchema,
} from "@src/tools/session-note-approve.js";

import { fakeDaemon } from "../helpers.js";

type SessionNoteApproveFn = DaemonClient["sessionNoteApprove"];
type SessionNoteApproveBody = Parameters<SessionNoteApproveFn>[0];

const validResponse: SessionNoteApproveResponse = {
  draft: {
    draft_id: "draft-1",
    session_id: null,
    project_id: null,
    period_key: "2026-08-31-pm",
    skeleton_path: "/tmp/a.skeleton.md",
    draft_path: "/tmp/a.draft.md",
    note_path: "/tmp/a.md",
    handoff_id: null,
    status: "edited",
    composed_at: "2026-08-31T20:00:00.000Z",
    reviewed_at: "2026-08-31T20:05:00.000Z",
    composed_event_id: null,
    review_event_id: 1,
  },
  event: null,
};

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

test("sessionNoteApproveHandler rejects approve:false before calling the daemon", async () => {
  let called = false;
  const sessionNoteApprove: SessionNoteApproveFn = () => {
    called = true;
    return Promise.resolve(validResponse);
  };
  const daemon = fakeDaemon({
    sessionNoteApprove,
  });
  const handler = sessionNoteApproveHandler(daemon);

  const err = await catchError(() => handler({ draft_id: "draft-1", approve: false }));
  expect(err).toBeInstanceOf(ZodError);
  expect(called).toBe(false);
});

test("sessionNoteApproveHandler rejects missing approve before calling the daemon", async () => {
  let called = false;
  const sessionNoteApprove: SessionNoteApproveFn = () => {
    called = true;
    return Promise.resolve(validResponse);
  };
  const daemon = fakeDaemon({
    sessionNoteApprove,
  });
  const handler = sessionNoteApproveHandler(daemon);

  const err = await catchError(() => handler({ draft_id: "draft-1" }));
  expect(err).toBeInstanceOf(ZodError);
  expect(called).toBe(false);
});

test("sessionNoteApproveHandler forwards approve:true verbatim", async () => {
  let received: SessionNoteApproveBody | null = null;
  const sessionNoteApprove: SessionNoteApproveFn = (body) => {
    received = body;
    return Promise.resolve(validResponse);
  };
  const daemon = fakeDaemon({
    sessionNoteApprove,
  });
  const handler = sessionNoteApproveHandler(daemon);

  await handler({ draft_id: "draft-1", approve: true, body: "edited\n", overwrite: true });

  expect(received).toEqual({
    draft_id: "draft-1",
    approve: true,
    body: "edited\n",
    overwrite: true,
  });
  expect(SessionNoteApproveInputSchema.parse(received)).toEqual(received);
});
