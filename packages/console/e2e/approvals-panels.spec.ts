import { test, expect, type Page } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

let fixture: E2EFixture;

const p1 = {
  permission_id: "p1",
  parent_handoff_id: "h1",
  conversation_id: "c1",
  agent_name: "codex",
  tool_name: "Bash",
  raw_input_json: "{}",
  status: "pending" as const,
  remember_scope: null,
  decision_reason: null,
  decided_by: null,
  ttl_at: "2026-09-08T12:00:00.000Z",
  created_at: "2026-09-08T10:00:00.000Z",
  decided_at: null,
};

const p2 = {
  ...p1,
  permission_id: "p2",
  created_at: "2026-09-08T11:00:00.000Z",
  ttl_at: "2026-09-08T13:00:00.000Z",
};

test.beforeAll(async () => {
  fixture = await bootFixture();
});

test.afterAll(async () => {
  await teardownFixture(fixture);
});

test.beforeEach(() => {
  fixture.harness.reset();
});

test("approve a permission: row gone, getCalls() has POST /permissions/p1/decide", async ({
  page,
}: {
  page: Page;
}) => {
  fixture.harness.setPermissions([p1]);
  await page.goto("/approvals");

  const row = page.locator('[data-testid="approval-row"][data-kind="permission"][data-id="p1"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole("button", { name: /^Approve$/ }).click();

  await expect(page.locator('[data-testid="approval-row"][data-kind="permission"]')).toHaveCount(
    0,
    { timeout: 2_000 },
  );
  await expect(page.locator('.rail-btn[title="Approvals"] .pip')).toBeHidden();

  const calls = fixture.harness.getCalls();
  const decideCall = calls.find((c) => c.method === "POST" && c.path === "/permissions/p1/decide");
  expect(decideCall).toBeDefined();
  expect(decideCall!.body).toMatchObject({ decision: "approve" });
});

test("a pushed permission SSE frame adds a row without reload", async ({
  page,
}: {
  page: Page;
}) => {
  fixture.harness.setPermissions([p1]);
  await page.goto("/approvals");
  await expect(page.locator('[data-testid="approval-row"][data-kind="permission"]')).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  await fixture.harness.waitForPermissionSseClient({ timeoutMs: 5_000 });
  fixture.harness.setPermissions([p1, p2]);
  fixture.harness.addPermissionEvent({
    kind: "permission.created",
    permission_id: "p2",
    seq: 1,
    payload: {},
  });

  await expect(page.locator('[data-testid="approval-row"][data-kind="permission"]')).toHaveCount(
    2,
    { timeout: 5_000 },
  );
});
