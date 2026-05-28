import { test, expect, type Page } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

let fixture: E2EFixture;

test.beforeAll(async () => {
  fixture = await bootFixture();
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

test.beforeEach(() => {
  fixture.harness.reset();
});

test("empty state copy renders for every panel when daemon returns nothing", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto("/mission");

  await expect(page.getByText("No handoffs awaiting approval.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("No chains running.")).toBeVisible();
  await expect(page.getByText("No resolved chains yet.")).toBeVisible();
  await expect(page.getByText("No pressure data available.")).toBeVisible();
});

test("pressure pip on the titlebar reflects the band", async ({ page }: { page: Page }) => {
  fixture.harness.setPressure([
    {
      used_pct: 0.4,
      warn_pct: 0.8,
      refuse_pct: 0.95,
      provider: "p1",
      model: "m1",
      window_label: "5m",
    },
  ]);
  await page.goto("/mission");
  await expect(page.locator(".pressure-pip-ok")).toBeVisible({ timeout: 10_000 });

  fixture.harness.setPressure([
    {
      used_pct: 0.85,
      warn_pct: 0.8,
      refuse_pct: 0.95,
      provider: "p1",
      model: "m1",
      window_label: "5m",
    },
  ]);
  await page.goto("/mission");
  await expect(page.locator(".pressure-pip-warn")).toBeVisible({ timeout: 10_000 });

  fixture.harness.setPressure([
    {
      used_pct: 0.97,
      warn_pct: 0.8,
      refuse_pct: 0.95,
      provider: "p1",
      model: "m1",
      window_label: "5m",
    },
  ]);
  await page.goto("/mission");
  await expect(page.locator(".pressure-pip-crit")).toBeVisible({ timeout: 10_000 });
});

test("in-flight chains panel shows hop count + status badge", async ({ page }: { page: Page }) => {
  fixture.harness.addChain({
    conversation_id: "conv-inflight-1",
    project_id: null,
    latest_status: "dispatched",
    latest_ts: new Date().toISOString(),
    earliest_ts: new Date().toISOString(),
    handoff_count: 5,
    root_handoff_id: "root-h1-abcdef01",
    to_agent: "claude",
    to_role: null,
    worktree_path: "/tmp/wt-inflight",
    worktree_root: null,
  });
  fixture.harness.addChain({
    conversation_id: "conv-inflight-2",
    project_id: "proj-1",
    latest_status: "dispatched",
    latest_ts: new Date().toISOString(),
    earliest_ts: new Date().toISOString(),
    handoff_count: 2,
    root_handoff_id: "root-h2-12345678",
    to_agent: "gemini",
    to_role: "reviewer",
    worktree_path: null,
    worktree_root: "/tmp/wt2",
  });

  await page.goto("/mission");
  await expect(page.getByText("In-flight chains")).toBeVisible({ timeout: 10_000 });
  const chainCards = page.locator(".chain-card");
  await expect(chainCards).toHaveCount(2, { timeout: 10_000 });

  await expect(chainCards.nth(0).locator(".chain-card-hops")).toHaveText("5 hops");
  await expect(chainCards.nth(0).locator(".chain-card-title")).toHaveText("root-h1-a");
  await expect(chainCards.nth(0).locator(".badge")).toBeVisible();

  await expect(chainCards.nth(1).locator(".chain-card-hops")).toHaveText("2 hops");
  await expect(chainCards.nth(1).locator(".badge")).toBeVisible();
});

test("recently resolved panel shows ok dots for completed and err dots for failed", async ({
  page,
}: {
  page: Page;
}) => {
  fixture.harness.addChain({
    conversation_id: "conv-done-1",
    project_id: null,
    latest_status: "completed",
    latest_ts: new Date().toISOString(),
    earliest_ts: new Date().toISOString(),
    handoff_count: 1,
    root_handoff_id: "done-one",
    to_agent: "claude",
    to_role: null,
    worktree_path: null,
    worktree_root: null,
  });
  fixture.harness.addChain({
    conversation_id: "conv-done-2",
    project_id: null,
    latest_status: "completed",
    latest_ts: new Date().toISOString(),
    earliest_ts: new Date().toISOString(),
    handoff_count: 2,
    root_handoff_id: "done-two",
    to_agent: "gemini",
    to_role: null,
    worktree_path: null,
    worktree_root: null,
  });
  fixture.harness.addChain({
    conversation_id: "conv-fail-1",
    project_id: null,
    latest_status: "failed",
    latest_ts: new Date().toISOString(),
    earliest_ts: new Date().toISOString(),
    handoff_count: 3,
    root_handoff_id: "fail-one",
    to_agent: "codex",
    to_role: null,
    worktree_path: null,
    worktree_root: null,
  });

  await page.goto("/mission");
  await expect(page.getByText("Recently resolved")).toBeVisible({ timeout: 10_000 });
  const rrRows = page.locator(".rr-row");
  await expect(rrRows).toHaveCount(3, { timeout: 10_000 });

  await expect(rrRows.nth(0).locator(":scope > .dot-ok")).toHaveCount(1);
  await expect(rrRows.nth(1).locator(":scope > .dot-ok")).toHaveCount(1);
  await expect(rrRows.nth(2).locator(":scope > .dot-err")).toHaveCount(1);
});
