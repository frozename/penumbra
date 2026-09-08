import { test, expect, type Page } from "@playwright/test";
import { bootFixture, teardownFixture, type E2EFixture } from "./_helpers";

let fixture: E2EFixture;

const BASE_TS = 1_756_200_000_000;

function seedInitiative(): void {
  fixture.harness.setRegistrarEntries([
    {
      registrar_id: "reg-e2e-1",
      slug: "plan-e2e",
      title: "E2E initiative",
      home_project: "penumbra",
      source_doc_path: null,
      status: "active",
      created_at: BASE_TS,
      updated_at: BASE_TS + 60_000,
    },
  ]);
  for (let phaseNo = 1; phaseNo <= 5; phaseNo += 1) {
    fixture.harness.addRegistrarPhase({
      registrar_id: "reg-e2e-1",
      phase_no: phaseNo,
      title: `Phase ${phaseNo}`,
      status: phaseNo <= 4 ? "complete" : "pending",
      updated_at: BASE_TS + phaseNo * 1000,
    });
  }
  fixture.harness.addRegistrarEvent({
    registrar_id: "reg-e2e-1",
    phase_no: 1,
    kind: "progress",
    state: null,
    ref_event_id: null,
    link_kind: null,
    link_value: null,
    actor: "maestro",
    body: "Kickoff complete",
    created_at: BASE_TS + 1000,
  });
  fixture.harness.addRegistrarEvent({
    registrar_id: "reg-e2e-1",
    phase_no: 2,
    kind: "blocker",
    state: "opened",
    ref_event_id: null,
    link_kind: null,
    link_value: null,
    actor: "worker",
    body: "Waiting on review",
    created_at: BASE_TS + 2000,
  });
  fixture.harness.addRegistrarEvent({
    registrar_id: "reg-e2e-1",
    phase_no: 3,
    kind: "follow_up",
    state: "owed",
    ref_event_id: null,
    link_kind: null,
    link_value: null,
    actor: "operator",
    body: "Document the kill switch",
    created_at: BASE_TS + 3000,
  });
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

test("empty-state copy renders when the daemon returns no entries", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto("/registrar");
  await expect(page.getByText("No initiatives registered.")).toBeVisible({ timeout: 10_000 });
});

test("list row shows status, phase progress, and open blocker/follow-up badges from the API", async ({
  page,
}: {
  page: Page;
}) => {
  seedInitiative();
  await page.goto("/registrar");

  const row = page.getByTestId("registrar-row");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("E2E initiative");
  await expect(page.getByTestId("registrar-status")).toHaveText("active");
  await expect(page.getByTestId("registrar-phase-progress")).toHaveText("4/5 phases");
  await expect(page.getByTestId("registrar-open-blockers")).toHaveText("1 blockers");
  await expect(page.getByTestId("registrar-open-follow-ups")).toHaveText("1 follow-ups");
});

test("the list renders rollups with no per-row detail request", async ({
  page,
}: {
  page: Page;
}) => {
  seedInitiative();
  await page.goto("/registrar");

  const row = page.getByTestId("registrar-row");
  await expect(row).toBeVisible({ timeout: 10_000 });

  const calls = fixture.harness.getCalls();
  expect(
    calls.filter((c) => c.method === "GET" && c.path === "/registrar").length,
  ).toBeGreaterThanOrEqual(1);
  expect(
    calls.filter((c) => c.method === "GET" && /^\/registrar\/[^/?]+/.test(c.path)),
  ).toHaveLength(0);
});

test("detail view renders the phase timeline in phase_no order and the journal chronologically", async ({
  page,
}: {
  page: Page;
}) => {
  seedInitiative();
  await page.goto("/registrar/reg-e2e-1");

  const phaseItems = page.getByTestId("phase-item");
  await expect(phaseItems).toHaveCount(5, { timeout: 10_000 });
  await expect(phaseItems.nth(0)).toContainText("P1");
  await expect(phaseItems.nth(0)).toContainText("complete");
  await expect(phaseItems.nth(4)).toContainText("P5");
  await expect(phaseItems.nth(4)).toContainText("pending");

  const journalItems = page.getByTestId("journal-event");
  await expect(journalItems).toHaveCount(3);
  await expect(journalItems.nth(0)).toContainText("Progress");
  await expect(journalItems.nth(0)).toContainText("Kickoff complete");
  await expect(journalItems.nth(1)).toContainText("Blocker");
  await expect(journalItems.nth(2)).toContainText("Follow-up");
  await expect(page.getByTestId("detail-open-blockers")).toHaveText("1 blockers");
});
