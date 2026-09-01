import { test, expect, type Page } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

let fixture: E2EFixture;

function seedSessions(): void {
  fixture.harness.setSessionEvents([
    {
      id: 1,
      session_id: "session-e2e-current",
      related_session_id: "session-e2e-prior",
      project_id: "penumbra",
      cwd: "/repo/penumbra",
      transcript_path: null,
      ref_path: "/notes/session-e2e.md",
      kind: "continuity.skeleton_generated",
      ts: "2026-09-01T10:00:00.000Z",
      meta: null,
    },
    {
      id: 2,
      session_id: "session-e2e-current",
      related_session_id: "session-e2e-prior",
      project_id: "penumbra",
      cwd: "/repo/penumbra",
      transcript_path: null,
      ref_path: "/notes/session-e2e.md",
      kind: "continuity.boot_pickup",
      ts: "2026-09-01T10:30:00.000Z",
      meta: null,
    },
    {
      id: 3,
      session_id: "session-e2e-current",
      related_session_id: "session-e2e-prior",
      project_id: "penumbra",
      cwd: "/repo/penumbra",
      transcript_path: null,
      ref_path: "/notes/session-e2e.md",
      kind: "continuity.note_superseded",
      ts: "2026-09-01T11:00:00.000Z",
      meta: null,
    },
  ]);
  fixture.harness.setSessionNoteDrafts([
    {
      draft_id: "draft-e2e-1",
      session_id: "session-e2e-current",
      project_id: "penumbra",
      period_key: "2026-09-01-am",
      skeleton_path: "/notes/skeleton.md",
      draft_path: "/notes/session-e2e-draft.md",
      note_path: "/notes/session-e2e.md",
      handoff_id: null,
      status: "awaiting_approval",
      composed_at: "2026-09-01T10:45:00.000Z",
      reviewed_at: null,
      composed_event_id: 1,
      review_event_id: null,
    },
  ]);
}

test.beforeAll(async () => {
  fixture = await bootFixture();
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

test.beforeEach(() => {
  fixture.harness.reset();
});

test("sessions view renders continuity events and read-only pending drafts", async ({
  page,
}: {
  page: Page;
}) => {
  seedSessions();
  await page.goto("/sessions");

  await expect(page.getByTestId("session-event-row")).toHaveCount(3, { timeout: 10_000 });
  await expect(page.getByTestId("session-event-superseded-badge")).toHaveText("superseded");
  await expect(page.getByTestId("pending-draft-row")).toContainText("2026-09-01-am");
  await expect(page.getByTestId("pending-draft-approve-command")).toContainText("draft-e2e-1");
  await expect(
    page.getByTestId("pending-draft-panel").locator('button, input, form, [role="button"]'),
  ).toHaveCount(0);
});
