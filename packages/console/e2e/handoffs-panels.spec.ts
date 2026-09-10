import { test, expect, type Page } from "@playwright/test";
import type { LaneRow } from "@penumbra/api-contract";

import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";
import type { AuditReportRow, DispatchEventRow, HarnessRow } from "./harness";

let fixture: E2EFixture;

function baseHarnessRow(id: string): Omit<HarnessRow, "status"> {
  return {
    handoff_id: id,
    from_agent: "maestro",
    to_agent: "claude",
    message: "e2e handoff message",
    ts: "2026-09-10T10:00:00.000Z",
    project_id: null,
    conversation_id: "conv-e2e",
    to_role: null,
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  };
}

function completedHandoff(id: string): HarnessRow {
  return {
    ...baseHarnessRow(id),
    status: "completed",
    resolved_by: "worker",
    resolved_at: "2026-09-10T10:05:00.000Z",
  };
}

function acceptAudit(handoffId: string): AuditReportRow {
  return {
    handoff_id: handoffId,
    status: "complete",
    terminal: true,
    trustworthy: true,
    summary: "ok",
    missing_events: [],
    evidence: {
      handoff_status: "completed",
      event_count: 0,
      response_count: 0,
      worktree_changed: null,
      dispatch_end_committed: null,
      reconciled: null,
      watchdog_failed: false,
      cancel_requested: false,
      adapter_streaming: null,
    },
    recommended_action: "accept",
  };
}

function openLane(id: string): LaneRow {
  return {
    lane_id: id,
    ts_opened: "2026-09-10T10:00:00.000Z",
    ts_closed: null,
    task_class: "STANDARD",
    implementer_handoff: "h-impl-01",
    reviewer_handoff: null,
    gate_status: "open",
    recalled_memory_ids: [],
    recalled_query: null,
    override_reason: null,
    metadata_json: "{}",
  };
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

test("land flow: Land → ff → confirm with reason → getCalls() has POST /dispatch/land then ≥2 GET /dispatch/land/<task_id>; the panel renders landed <sha> and land-task-id carries the accepted task_id", async ({
  page,
}: {
  page: Page;
}) => {
  const handoffId = "h-land-ff-01";
  const commitSubject = "feat(console): land from e2e";

  fixture.harness.setHandoffs([completedHandoff(handoffId)]);
  fixture.harness.setAudit(handoffId, acceptAudit(handoffId));

  await page.goto(`/handoffs/${handoffId}`);

  await expect(page.getByTestId("land-button")).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId("land-mode-ff").check();
  await page.getByTestId("land-subject").fill(commitSubject);
  await page.getByTestId("land-button").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("ff");
  await expect(dialog).toContainText(commitSubject);
  await expect(dialog.locator('[data-testid="land-mode-ff"]')).toHaveCount(0);
  await expect(dialog.locator('[data-testid="land-subject"]')).toHaveCount(0);

  await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await page.getByLabel("Reason").fill("land looks good");
  await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await page.getByLabel("Confirmation target").fill(handoffId);

  const [postResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/dispatch/land" && response.request().method() === "POST";
    }),
    page.getByRole("button", { name: "Confirm" }).click(),
  ]);

  const postBody = (await postResponse.json()) as { task_id: string };
  const taskId = postBody.task_id;

  await expect(page.locator('[data-testid="land-task-id"]')).toHaveText(taskId, {
    timeout: 10_000,
  });
  await expect(page.locator('[data-testid="land-result"]')).toHaveText("landed abc123", {
    timeout: 20_000,
  });

  const calls = fixture.harness.getCalls();
  const landPosts = calls.filter((c) => c.method === "POST" && c.path === "/dispatch/land");
  expect(landPosts).toHaveLength(1);
  expect(landPosts[0]!.body).toEqual({
    handoff_id: handoffId,
    mode: "ff",
    commit_message: commitSubject,
  });

  const taskGets = calls.filter((c) => c.method === "GET" && c.path === `/dispatch/land/${taskId}`);
  expect(taskGets.length).toBeGreaterThanOrEqual(2);

  const postIndex = calls.findIndex((c) => c.method === "POST" && c.path === "/dispatch/land");
  const firstGetIndex = calls.findIndex(
    (c) => c.method === "GET" && c.path === `/dispatch/land/${taskId}`,
  );
  expect(postIndex).toBeGreaterThanOrEqual(0);
  expect(firstGetIndex).toBeGreaterThan(postIndex);
});

test("deep link /handoffs/<id> renders detail without the list", async ({
  page,
}: {
  page: Page;
}) => {
  const handoffId = "h-deep-link-01";
  const message = "deep link handoff message";

  const row: HarnessRow = {
    ...baseHarnessRow(handoffId),
    status: "completed",
    message,
    resolved_by: "worker",
    resolved_at: "2026-09-10T10:05:00.000Z",
  };

  const events: DispatchEventRow[] = [
    {
      handoff_id: handoffId,
      worker_id: null,
      source: "daemon",
      kind: "dispatch.start",
      ts: "2026-09-10T10:00:00.000Z",
      meta: null,
    },
  ];

  fixture.harness.setHandoffs([
    row,
    {
      ...baseHarnessRow("h-pending-not-rendered"),
      status: "pending",
      message: "pending list sentinel",
    },
  ]);
  fixture.harness.setDispatchEvents(handoffId, events);

  await page.goto(`/handoffs/${handoffId}`);

  const identityLink = page.locator(`h1 a[href="/handoffs/${handoffId}"]`);
  await expect(identityLink).toBeVisible({ timeout: 10_000 });
  await expect(identityLink).toHaveText(handoffId);

  await expect(page.getByTestId("handoff-message")).toHaveText(message);
  await expect(page.getByText("Dispatch timeline")).toBeVisible();
  await expect(page.locator('[data-testid="dispatch-timeline"]')).toBeVisible();

  await expect(page.locator('[role="tablist"]')).toHaveCount(0);
  await expect(page.getByLabel("Agent filter")).toHaveCount(0);
  await expect(page.getByText("pending list sentinel", { exact: true })).toHaveCount(0);
  await expect(page.locator('.rail-btn[title="Approvals"] .pip')).toHaveText("1");

  const calls = fixture.harness.getCalls();
  expect(calls.some((c) => c.method === "GET" && c.path === `/handoffs/${handoffId}`)).toBe(true);
  const badgeReads = calls.filter(
    (c) => c.method === "GET" && c.path === "/handoffs?status=pending",
  );
  expect(badgeReads).toHaveLength(1);
});

test("close lane posts /lanes/close", async ({ page }: { page: Page }) => {
  const laneId = "lane-close-01";
  const reviewerHandoffId = "h-reviewer-01";
  const notes = "reviewed and passed";

  fixture.harness.setLanes([openLane(laneId)]);

  await page.goto("/handoffs");
  await page.getByRole("tab", { name: "Lanes" }).click();

  const row = page.locator('[data-testid="lane-row"]').filter({ hasText: laneId });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: `Close lane ${laneId}` }).click();

  await expect(page.getByText(`Close lane ${laneId}`)).toBeVisible();
  await page.getByLabel("Gate status").selectOption("passed");
  await page.getByLabel("Reviewer handoff").fill(reviewerHandoffId);
  await page.getByLabel("Notes").fill(notes);
  await page.getByTestId("lane-close-submit").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByLabel("Reason").fill("reviewer signed off");
  await page.getByLabel("Confirmation target").fill(laneId);
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("button", { name: `Close lane ${laneId}` })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(row).toContainText("passed");

  const reviewerLink = row.locator(`a[href="/handoffs/${reviewerHandoffId}"]`);
  await expect(reviewerLink).toBeVisible();
  await expect(reviewerLink).toHaveText(reviewerHandoffId);

  const calls = fixture.harness.getCalls();
  const closeCalls = calls.filter((c) => c.method === "POST" && c.path === "/lanes/close");
  expect(closeCalls).toHaveLength(1);
  expect(closeCalls[0]!.body).toEqual({
    lane_id: laneId,
    gate_status: "passed",
    reviewer_handoff: reviewerHandoffId,
    metadata: { notes },
  });
});
