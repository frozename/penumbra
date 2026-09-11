import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { type E2EHarness, startHarness } from "../../e2e/harness/index";

let h: E2EHarness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

function get(path: string): Promise<Response> {
  return Bun.fetch(`${h.baseUrl}${path}`, { headers: { Authorization: `Bearer ${h.token}` } });
}
function post(path: string, body?: string): Promise<Response> {
  return Bun.fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
    body,
  });
}

const draftPath = "/task-drafts/pending?latest_event_type=task_draft&project_id=p";
const escalationPath = "/task-drafts/pending-escalations?project_id=p";

describe("task draft fixture validation", () => {
  test("required fields, enum, and bounded integer limits match the daemon", async () => {
    const paths = [
      "/task-drafts/pending?project_id=p",
      "/task-drafts/pending?latest_event_type=task_draft",
      "/task-drafts/pending?latest_event_type=other&project_id=p",
      "/task-drafts/pending?latest_event_type=task_draft&project_id=",
      "/task-drafts/pending-escalations",
      "/task-drafts/pending-escalations?project_id=",
    ];
    for (const path of [draftPath, escalationPath]) {
      for (const limit of ["", "0", "-1", "51", "1.5", "2junk", "NaN"]) {
        paths.push(`${path}&limit=${limit}`);
      }
    }
    for (const path of paths) {
      const response = await get(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "validation_error",
          message: "query failed schema validation",
          field_errors: expect.any(Array) as unknown,
        },
      });
    }
  });

  test("draft rows preserve payload, isolate projects, replace, limit, and reset", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      draft_id: `draft-${String(i)}`,
      project_id: "p",
      prompt: "draft",
      evidence: { files: ["a.ts"] },
    }));
    h.setTaskDrafts([{ draft_id: "obsolete", project_id: "p" }]);
    h.setTaskDrafts([{ draft_id: "foreign", project_id: "q" }, { project_id: null }, ...rows]);
    h.setTaskDraftEscalations([{ draft_id: "obsolete", project_id: "p" }]);
    h.setTaskDraftEscalations([
      { draft_id: "foreign", project_id: "q" },
      { project_id: null },
      ...rows,
    ]);
    for (const [path, key] of [
      [draftPath, "drafts"],
      [escalationPath, "escalations"],
    ] as const) {
      const defaults = (await (await get(`${path}&unknown=ignored`)).json()) as Record<
        string,
        unknown[]
      >;
      expect(defaults[key]).toEqual(rows.slice(0, 5));
      expect(await (await get(`${path}&limit=1`)).json()).toEqual({ [key]: rows.slice(0, 1) });
      expect(await (await get(`${path}&limit=50`)).json()).toEqual({ [key]: rows });
    }
    expect(
      await (await get(draftPath.replace("=task_draft", "=task_draft_escalation"))).json(),
    ).toEqual({ drafts: [] });
    h.reset();
    expect(await (await get(draftPath)).json()).toEqual({ drafts: [] });
    expect(await (await get(escalationPath)).json()).toEqual({ escalations: [] });
  });
});

describe("task fixture queries and mutation bodies", () => {
  test("optional row fields and extras survive reads, filters, pagination, and mutation", async () => {
    const row = {
      task_id: "t1",
      kind: "work" as const,
      status: "pending" as const,
      bounds: { cost_cents: 2 },
      lease: { lease_id: "l1" },
      extra: ["preserved"],
    };
    h.setTasks([{ task_id: "old" }]);
    h.setTasks([
      { task_id: "minimal" },
      { task_id: "other", kind: "review", status: "pending" },
      { ...row, task_id: "t0" },
      row,
    ]);
    expect(await (await get("/tasks/minimal")).json()).toEqual({ task_id: "minimal" });
    expect(
      await (await get("/tasks?kind=work&status=pending&limit=1&offset=1&unknown=ignored")).json(),
    ).toEqual({ tasks: [row] });
    expect(await (await get("/tasks/t1")).json()).toEqual(row);
    expect((await post("/tasks/t1/cancel", JSON.stringify({ reason: "stop" }))).status).toBe(200);
    expect(await (await get("/tasks/t1")).json()).toEqual({ ...row, status: "cancelled" });
    h.reset();
    expect(await (await get("/tasks")).json()).toEqual({ tasks: [] });
  });

  test("list rejects invalid known fields and uses a default limit of 50", async () => {
    h.setTasks(Array.from({ length: 51 }, (_, i) => ({ task_id: `t${String(i)}` })));
    const response = (await (await get("/tasks")).json()) as { tasks: unknown[] };
    expect(response.tasks).toHaveLength(50);
    for (const query of [
      "status=bogus",
      "kind=bogus",
      "limit=0",
      "limit=501",
      "limit=2junk",
      "limit=1.5",
      "offset=-1",
      "offset=1.5",
      "origin=",
      "parent_task_id=",
      "eligible_for=",
    ]) {
      const invalid = await get(`/tasks?${query}`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "invalid_input" });
    }
  });

  test("create preserves parsed fields and defaults kind to work", async () => {
    const input = {
      prompt: "implement",
      created_by_kind: "human",
      created_by_id: "operator",
      project_id: "p",
      bounds: { cost_cents: 3 },
      eligibility: { required_tags: ["ts"] },
      priority: "high",
      requires_review: true,
      expected_artifacts: [{ type: "commit" }],
      review_eligibility: { min_tier: "standard" },
      acceptance_criteria: "works",
      branch_base: "main",
    };
    const response = await post("/tasks", JSON.stringify(input));
    expect(response.status).toBe(200);
    const created = (await response.json()) as { task_id: string };
    expect(await (await get(`/tasks/${created.task_id}`)).json()).toMatchObject({
      ...input,
      task_id: created.task_id,
      kind: "work",
      status: "pending",
      created_at: expect.any(String) as unknown,
    });
    for (const body of [
      undefined,
      "{",
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...input, prompt: "" }),
      JSON.stringify({ ...input, bounds: { cost_cents: -1 } }),
    ]) {
      const invalid = await post("/tasks", body);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "invalid_input" });
    }
  });

  test("cancel, fail, and GH bodies validate before mutating", async () => {
    h.setTasks([{ task_id: "t", status: "pending" }]);
    for (const [route, bodies] of [
      ["cancel", [undefined, "null", '{"reason":2}', '{"extra":true}']],
      ["fail", [undefined, "null", "{}", '{"reason":"why"}', '{"lease_id":"l","reason":""}']],
      [
        "link-gh",
        [
          undefined,
          "null",
          "{}",
          '{"repo":"r","issue_number":0}',
          '{"repo":"","issue_number":1}',
          '{"repo":"r","issue_number":1.5}',
        ],
      ],
      ["comment-gh", [undefined, "null", "{}", '{"body":""}', '{"body":2}']],
    ] as const) {
      for (const body of bodies) {
        const invalid = await post(`/tasks/t/${route}`, body);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: "invalid_input" });
      }
    }
    expect(await (await get("/tasks/t")).json()).toEqual({ task_id: "t", status: "pending" });
    expect((await post("/tasks/t/fail", '{"lease_id":"l","reason":"failed"}')).status).toBe(200);
    expect(await (await get("/tasks/t")).json()).toMatchObject({ status: "failed" });
    expect((await post("/tasks/t/link-gh", '{"repo":"owner/repo","issue_number":3}')).status).toBe(
      200,
    );
    expect(await (await get("/tasks/t")).json()).toMatchObject({
      gh_issue_repo: "owner/repo",
      gh_issue_number: 3,
    });
    const comment = await post("/tasks/t/comment-gh", '{"body":"fixture only"}');
    expect(await comment.json()).toEqual({
      comment_url: "https://github.com/owner/repo/issues/3#issuecomment-1",
    });
    expect((await post("/tasks/t/unlink-gh", "{}")).status).toBe(200);
    expect(await (await get("/tasks/t")).json()).toMatchObject({
      gh_issue_repo: null,
      gh_issue_number: null,
    });
  });

  test("sync rejects null, absent, malformed, and invalid bodies but accepts empty object", async () => {
    for (const body of [
      undefined,
      "{",
      "null",
      "[]",
      '"text"',
      '{"task_id":""}',
      '{"task_id":1}',
      '{"unknown":true}',
    ]) {
      const response = await post("/tasks/sync-gh-now", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_input" });
    }
    const response = await post("/tasks/sync-gh-now", "{}");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      linked: 0,
      pushed: 0,
      pulled: 0,
      errored: 0,
      skipped: true,
      results: [],
    });
  });
});

test("task mutations preserve the daemon missing-JSON error", async () => {
  for (const path of [
    "/tasks",
    "/tasks/t/cancel",
    "/tasks/t/fail",
    "/tasks/t/link-gh",
    "/tasks/t/comment-gh",
    "/tasks/sync-gh-now",
  ]) {
    for (const body of [undefined, "{", "null"]) {
      const response = await post(path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_input",
        details: [{ message: "request body was not valid JSON" }],
      });
    }
  }
});
