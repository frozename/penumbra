import { test, expect } from "@playwright/test";
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

test("t0 tail filter narrows the visible rows", async ({ page }) => {
  await page.goto("/mission");
  await expect(page.locator(".card-head h3", { hasText: "t0 events" })).toBeVisible();

  for (let i = 0; i < 3; i++) {
    fixture.harness.pushEvent({
      event: "agent-prompt",
      data: { ts: new Date().toISOString(), event: "agent-prompt", meta: { i } },
    });
  }
  for (let i = 0; i < 2; i++) {
    fixture.harness.pushEvent({
      event: "agent-response",
      data: { ts: new Date().toISOString(), event: "agent-response", meta: { i } },
    });
  }

  await expect(page.locator(".t0-row")).toHaveCount(5, { timeout: 5_000 });

  const filterInput = page.getByPlaceholder("filter…");
  await filterInput.fill("agent-prompt");
  await expect(page.locator(".t0-row")).toHaveCount(3);

  await filterInput.fill("");
  await expect(page.locator(".t0-row")).toHaveCount(5);
});

test("pause stops new events from appearing; resume keeps the paused snapshot", async ({
  page,
}) => {
  await page.goto("/mission");
  await expect(page.locator(".card-head h3", { hasText: "t0 events" })).toBeVisible({
    timeout: 10_000,
  });

  for (let i = 0; i < 3; i++) {
    fixture.harness.pushEvent({
      event: "agent-prompt",
      data: { ts: new Date().toISOString(), event: "agent-prompt", i },
    });
  }
  await expect(page.locator(".t0-row")).toHaveCount(3, { timeout: 5_000 });

  await page.getByRole("button", { name: "⏸ pause" }).click();

  for (let i = 0; i < 2; i++) {
    fixture.harness.pushEvent({
      event: "agent-tool-use",
      data: { ts: new Date().toISOString(), event: "agent-tool-use", i },
    });
  }

  await page.waitForTimeout(500);
  await expect(page.locator(".t0-row")).toHaveCount(3);

  await page.getByRole("button", { name: "▶ resume" }).click();

  fixture.harness.pushEvent({
    event: "agent-prompt",
    data: { ts: new Date().toISOString(), event: "agent-prompt", last: true },
  });

  await expect(page.locator(".t0-row")).toHaveCount(4, { timeout: 5_000 });
});

test("reconnect synthetic shows the banner and clears the visible list", async ({ page }) => {
  await page.goto("/mission");
  await expect(page.locator(".card-head h3", { hasText: "t0 events" })).toBeVisible({
    timeout: 10_000,
  });

  for (let i = 0; i < 3; i++) {
    fixture.harness.pushEvent({
      event: "agent-prompt",
      data: { ts: new Date().toISOString(), event: "agent-prompt", i },
    });
  }
  await expect(page.locator(".t0-row")).toHaveCount(3, { timeout: 5_000 });

  fixture.harness.simulateReconnect();

  await expect(page.locator("text=/reconnected/i")).toBeVisible({ timeout: 10_000 });

  await page.waitForTimeout(500);
  fixture.harness.pushEvent({
    event: "agent-tool-use",
    data: { ts: new Date().toISOString(), event: "agent-tool-use", fresh: true },
  });

  await expect(page.locator(".t0-row")).toHaveCount(1, { timeout: 5_000 });
});
