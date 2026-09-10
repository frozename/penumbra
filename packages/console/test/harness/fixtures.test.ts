import { DispatchLandTaskSchema } from "@penumbra/api-contract";
import { describe, expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { startHarness } from "../../e2e/harness/index";

describe("permissions fixture", () => {
  test("addPermissionEvent throws when no permission SSE client is connected", async () => {
    const h = await startHarness();
    try {
      expect(() => {
        h.addPermissionEvent({
          kind: "permission.decided",
          permission_id: "p1",
          seq: 1,
          payload: { decision: "approve" },
        });
      }).toThrow(/waitForPermissionSseClient/);
    } finally {
      await h.stop();
    }
  });

  test("GET /permissions defaults to pending, accepts a comma list and 400s an unknown status", async () => {
    const h = await startHarness();
    try {
      h.setPermissions([
        {
          permission_id: "p1",
          parent_handoff_id: "h-1",
          conversation_id: "c-1",
          agent_name: "a",
          tool_name: "t",
          raw_input_json: "{}",
          status: "pending",
          remember_scope: null,
          decision_reason: null,
          decided_by: null,
          ttl_at: "2026-09-01T10:05:00.000Z",
          created_at: "2026-09-01T10:00:00.000Z",
          decided_at: null,
        },
        {
          permission_id: "p2",
          parent_handoff_id: "h-2",
          conversation_id: "c-2",
          agent_name: "a",
          tool_name: "t",
          raw_input_json: "{}",
          status: "approved",
          remember_scope: null,
          decision_reason: null,
          decided_by: null,
          ttl_at: "2026-09-01T10:05:00.000Z",
          created_at: "2026-09-01T10:00:00.000Z",
          decided_at: null,
        },
      ]);

      const defaultRes = await Bun.fetch(`${h.baseUrl}/permissions`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const defaultBody = (await defaultRes.json()) as {
        permissions: { permission_id: string }[];
      };
      expect(defaultBody.permissions).toHaveLength(1);
      expect(defaultBody.permissions[0]!.permission_id).toBe("p1");

      const listRes = await Bun.fetch(`${h.baseUrl}/permissions?status=pending,approved`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const listBody = (await listRes.json()) as {
        permissions: { permission_id: string }[];
      };
      expect(listBody.permissions).toHaveLength(2);
      const ids = listBody.permissions.map((p) => p.permission_id).sort();
      expect(ids).toEqual(["p1", "p2"]);

      const bogusRes = await Bun.fetch(`${h.baseUrl}/permissions?status=bogus`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(bogusRes.status).toBe(400);
      const bogusBody = (await bogusRes.json()) as { error: { code: string } };
      expect(bogusBody.error.code).toBe("validation_error");
    } finally {
      await h.stop();
    }
  });

  test("the permissions fixture serves list/get/decide and an SSE /permissions/events frame 'event: <kind>\\nid: <permission_id>:<seq>'", async () => {
    const h = await startHarness();
    try {
      h.setPermissions([
        {
          permission_id: "p1",
          parent_handoff_id: "h-1",
          conversation_id: "c-1",
          agent_name: "a",
          tool_name: "t",
          raw_input_json: "{}",
          status: "pending",
          remember_scope: null,
          decision_reason: null,
          decided_by: null,
          ttl_at: "2026-09-01T10:05:00.000Z",
          created_at: "2026-09-01T10:00:00.000Z",
          decided_at: null,
        },
      ]);

      const listRes = await Bun.fetch(`${h.baseUrl}/permissions`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const listBody = (await listRes.json()) as { permissions: { permission_id: string }[] };
      expect(listBody.permissions).toHaveLength(1);
      expect(listBody.permissions[0]!.permission_id).toBe("p1");

      const decideRes = await Bun.fetch(`${h.baseUrl}/permissions/p1/decide`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${h.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(decideRes.status).toBe(200);

      const getRes = await Bun.fetch(`${h.baseUrl}/permissions/p1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const getBody = (await getRes.json()) as {
        permission: { status: string };
      };
      expect(getBody.permission.status).toBe("approved");

      const sseRes = await Bun.fetch(`${h.baseUrl}/permissions/events`, {
        headers: { Authorization: `Bearer ${h.token}`, Accept: "text/event-stream" },
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.body).not.toBeNull();
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let receivedEvent = false;

      const readPromise = (async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (accumulated.includes("event: permission.decided\nid: p1:")) {
            receivedEvent = true;
            break;
          }
        }
      })();

      await h.waitForPermissionSseClient();

      h.addPermissionEvent({
        kind: "permission.decided",
        permission_id: "p1",
        seq: 1,
        payload: { decision: "approve" },
      });

      await Promise.race([
        readPromise,
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error("SSE timeout"));
          }, 5_000);
        }),
      ]);

      expect(receivedEvent).toBe(true);
      expect(accumulated).toContain("event: permission.decided\nid: p1:");
      reader.cancel().catch(() => {
        // ignore cancel errors during teardown
      });
    } finally {
      await h.stop();
    }
  });
});

describe("registrar fixture", () => {
  test("GET /registrar list entries carry rollup and phase_progress computed from harness phases and events", async () => {
    const h = await startHarness();
    const BASE_TS = 1_756_200_000_000;
    try {
      h.setRegistrarEntries([
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
        {
          registrar_id: "reg-e2e-2",
          slug: "plan-e2e-second",
          title: "Second E2E initiative",
          home_project: "penumbra",
          source_doc_path: null,
          status: "active",
          created_at: BASE_TS,
          updated_at: BASE_TS + 30_000,
        },
      ]);
      const phaseStatuses = [
        "complete",
        "complete",
        "complete",
        "complete",
        "pending",
        "abandoned",
      ] as const;
      for (const [index, status] of phaseStatuses.entries()) {
        h.addRegistrarPhase({
          registrar_id: "reg-e2e-1",
          phase_no: index + 1,
          title: `Phase ${String(index + 1)}`,
          status,
          updated_at: BASE_TS + (index + 1) * 1000,
        });
      }
      h.addRegistrarEvent({
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
      h.addRegistrarEvent({
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
      h.addRegistrarEvent({
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
      const secondPhaseStatuses = ["complete", "pending"] as const;
      for (const [index, status] of secondPhaseStatuses.entries()) {
        h.addRegistrarPhase({
          registrar_id: "reg-e2e-2",
          phase_no: index + 1,
          title: `Second phase ${String(index + 1)}`,
          status,
          updated_at: BASE_TS + (index + 1) * 1000,
        });
      }
      h.addRegistrarEvent({
        registrar_id: "reg-e2e-2",
        phase_no: 1,
        kind: "blocker",
        state: "opened",
        ref_event_id: null,
        link_kind: null,
        link_value: null,
        actor: "worker",
        body: "Second registrar blocker",
        created_at: BASE_TS + 4000,
      });

      const res = await Bun.fetch(`${h.baseUrl}/registrar`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: {
          registrar_id: string;
          rollup?: { open_blockers: number; open_follow_ups: number };
          phase_progress?: { complete: number; total: number };
        }[];
      };
      expect(body.entries[0]!.phase_progress).toEqual({ complete: 4, total: 6 });
      expect(body.entries[0]!.rollup).toEqual({ open_blockers: 1, open_follow_ups: 1 });
      expect(body.entries[1]!.phase_progress).toEqual({ complete: 1, total: 2 });
      expect(body.entries[1]!.rollup).toEqual({ open_blockers: 1, open_follow_ups: 0 });
    } finally {
      await h.stop();
    }
  });

  test("a closing event of a different kind does not close a blocker", async () => {
    const h = await startHarness();
    const BASE_TS = 1_756_200_000_000;
    try {
      h.setRegistrarEntries([
        {
          registrar_id: "reg-e2e-kinds",
          slug: "plan-e2e-kinds",
          title: "Kind mismatch initiative",
          home_project: "penumbra",
          source_doc_path: null,
          status: "active",
          created_at: BASE_TS,
          updated_at: BASE_TS + 60_000,
        },
      ]);
      h.addRegistrarEvent({
        event_id: 1,
        registrar_id: "reg-e2e-kinds",
        phase_no: 1,
        kind: "blocker",
        state: "opened",
        ref_event_id: null,
        link_kind: null,
        link_value: null,
        actor: "worker",
        body: "Waiting on review",
        created_at: BASE_TS + 1000,
      });
      h.addRegistrarEvent({
        registrar_id: "reg-e2e-kinds",
        phase_no: 1,
        kind: "follow_up",
        state: "done",
        ref_event_id: 1,
        link_kind: null,
        link_value: null,
        actor: "operator",
        body: "Follow-up closed against the blocker id",
        created_at: BASE_TS + 2000,
      });

      const res = await Bun.fetch(`${h.baseUrl}/registrar`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: {
          registrar_id: string;
          rollup?: { open_blockers: number; open_follow_ups: number };
        }[];
      };
      expect(body.entries[0]!.rollup).toEqual({ open_blockers: 1, open_follow_ups: 0 });
    } finally {
      await h.stop();
    }
  });
});

function baseHarnessRow(id: string): Omit<import("../../e2e/harness/server").HarnessRow, "status"> {
  return {
    handoff_id: id,
    from_agent: "a",
    to_agent: "b",
    message: "m",
    ts: "2026-05-08T00:00:00Z",
    project_id: null,
    conversation_id: "c1",
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

describe("handoffs fixture", () => {
  test("harness boots without duplicate route errors", async () => {
    const h = await startHarness();
    try {
      expect(h.baseUrl).toBeTruthy();
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs filters by status, agent, project_id", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([
        {
          ...baseHarnessRow("h1"),
          status: "pending",
          to_agent: "claude",
          project_id: "p-1",
        },
        {
          ...baseHarnessRow("h2"),
          status: "dispatched",
          to_agent: "gemini",
          project_id: "p-2",
        },
        {
          ...baseHarnessRow("h3"),
          status: "pending",
          to_agent: "claude",
          project_id: "p-2",
        },
      ]);

      const statusRes = await Bun.fetch(`${h.baseUrl}/handoffs?status=dispatched`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const statusBody = (await statusRes.json()) as { handoffs: { handoff_id: string }[] };
      expect(statusBody.handoffs).toHaveLength(1);
      expect(statusBody.handoffs[0]!.handoff_id).toBe("h2");

      const agentRes = await Bun.fetch(`${h.baseUrl}/handoffs?agent=claude`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const agentBody = (await agentRes.json()) as { handoffs: { handoff_id: string }[] };
      expect(agentBody.handoffs).toHaveLength(2);
      expect(agentBody.handoffs.map((r) => r.handoff_id).sort()).toEqual(["h1", "h3"]);

      const projRes = await Bun.fetch(`${h.baseUrl}/handoffs?project_id=p-2`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const projBody = (await projRes.json()) as { handoffs: { handoff_id: string }[] };
      expect(projBody.handoffs).toHaveLength(2);
      expect(projBody.handoffs.map((r) => r.handoff_id).sort()).toEqual(["h2", "h3"]);

      const combinedRes = await Bun.fetch(
        `${h.baseUrl}/handoffs?status=pending&agent=claude&project_id=p-2`,
        { headers: { Authorization: `Bearer ${h.token}` } },
      );
      const combinedBody = (await combinedRes.json()) as { handoffs: { handoff_id: string }[] };
      expect(combinedBody.handoffs).toHaveLength(1);
      expect(combinedBody.handoffs[0]!.handoff_id).toBe("h3");
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/:id returns handoff detail matching shared schema", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([{ ...baseHarnessRow("h/1"), status: "pending" }]);
      const res = await Bun.fetch(`${h.baseUrl}/handoffs/h%2F1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { handoff: { handoff_id: string } };
      expect(body.handoff.handoff_id).toBe("h/1");
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/:id returns 404 for missing handoff", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/handoffs/missing`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/:id/status returns status matching shared schema", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([{ ...baseHarnessRow("h1"), status: "dispatched" }]);
      const res = await Bun.fetch(`${h.baseUrl}/handoffs/h1/status`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        handoff_id: string;
        status: string;
        reliability: { status: string; recommended_action: string };
      };
      expect(body.handoff_id).toBe("h1");
      expect(body.status).toBe("dispatched");
      expect(body.reliability).toBeDefined();
      expect(body.reliability.recommended_action).toBeDefined();
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/:id/status returns 404 for missing handoff", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/handoffs/missing/status`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });

  test("POST /handoffs/:id/fail changes row status to failed", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([{ ...baseHarnessRow("h1"), status: "dispatched" }]);
      const res = await Bun.fetch(`${h.baseUrl}/handoffs/h1/fail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "broken" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { handoff_id: string; status: string };
      expect(body).toEqual({ handoff_id: "h1", status: "failed" });

      const getRes = await Bun.fetch(`${h.baseUrl}/handoffs/h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const getBody = (await getRes.json()) as { handoff: { status: string } };
      expect(getBody.handoff.status).toBe("failed");
    } finally {
      await h.stop();
    }
  });

  test("POST /handoffs/:id/fail returns 404 for missing handoff", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/handoffs/missing/fail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "broken" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});

describe("dispatch-events fixture", () => {
  test("GET /dispatch/events?handoff_id=h1 returns events", async () => {
    const h = await startHarness();
    try {
      h.setDispatchEvents("h1", [
        {
          handoff_id: "h1",
          worker_id: "w1",
          source: "worker",
          kind: "dispatch.start",
          ts: "2026-05-08T00:00:00Z",
          meta: null,
        },
      ]);
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/events?handoff_id=h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: { kind: string }[] };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]!.kind).toBe("dispatch.start");
    } finally {
      await h.stop();
    }
  });

  test("GET /dispatch/events without handoff_id returns 400 {error:'missing_handoff_id'}", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/events`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_handoff_id");
    } finally {
      await h.stop();
    }
  });

  test("error injection works on /dispatch/events", async () => {
    const h = await startHarness();
    try {
      h.injectError("/dispatch/events", 500);
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/events?handoff_id=h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(500);
    } finally {
      await h.stop();
    }
  });
});

describe("dispatch-audit fixture", () => {
  test("GET /dispatch/audit?handoff_id=h1 returns report", async () => {
    const h = await startHarness();
    try {
      h.setAudit("h1", {
        handoff_id: "h1",
        status: "complete",
        terminal: true,
        trustworthy: true,
        summary: "ok",
        missing_events: [],
        evidence: {
          handoff_status: "completed",
          event_count: 5,
          response_count: 1,
          worktree_changed: true,
          dispatch_end_committed: true,
          reconciled: null,
          watchdog_failed: false,
          cancel_requested: false,
          adapter_streaming: null,
        },
        recommended_action: "accept",
      });
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/audit?handoff_id=h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { report: { status: string; recommended_action: string } };
      expect(body.report.status).toBe("complete");
      expect(body.report.recommended_action).toBe("accept");
    } finally {
      await h.stop();
    }
  });

  test("GET /dispatch/audit without handoff_id returns 400 {error:'missing_handoff_id'}", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/audit`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_handoff_id");
    } finally {
      await h.stop();
    }
  });

  test("error injection works on /dispatch/audit", async () => {
    const h = await startHarness();
    try {
      h.injectError("/dispatch/audit", 500);
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/audit?handoff_id=h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(500);
    } finally {
      await h.stop();
    }
  });
});

describe("dispatch-land fixture", () => {
  test("POST /dispatch/land returns 202 {ok:true,task_id,status:'queued'} without handoff_id", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/land`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handoff_id: "h1" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { ok: boolean; task_id: string; status: string };
      expect(body.ok).toBe(true);
      expect(body.task_id).toBeTruthy();
      expect(body.status).toBe("queued");
      expect(body).not.toHaveProperty("handoff_id");
    } finally {
      await h.stop();
    }
  });

  test("GET /dispatch/land/:id advances queued→running→done→done and returns 8-field schema", async () => {
    const h = await startHarness();
    try {
      const postRes = await Bun.fetch(`${h.baseUrl}/dispatch/land`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handoff_id: "h1" }),
      });
      const postBody = (await postRes.json()) as { task_id: string };
      const taskId = postBody.task_id;

      const poll1 = await Bun.fetch(`${h.baseUrl}/dispatch/land/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(poll1.status).toBe(200);
      const rawTask1 = (await poll1.json()) as Record<string, unknown>;
      expect(Object.keys(rawTask1)).toHaveLength(8);
      const task1 = DispatchLandTaskSchema.parse(rawTask1);
      expect(task1.status).toBe("queued");
      expect(task1.task_id).toBe(taskId);
      expect(task1.handoff_id).toBe("h1");
      expect(task1.created_at).toBeDefined();
      expect(task1.started_at).toBeNull();
      expect(task1.finished_at).toBeNull();
      expect(task1.result).toBeNull();
      expect(task1.error).toBeNull();

      const poll2 = await Bun.fetch(`${h.baseUrl}/dispatch/land/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const task2 = DispatchLandTaskSchema.parse(await poll2.json());
      expect(task2.status).toBe("running");
      expect(typeof task2.started_at).toBe("string");
      expect(task2.finished_at).toBeNull();
      expect(task2.result).toBeNull();
      expect(task2.error).toBeNull();

      const poll3 = await Bun.fetch(`${h.baseUrl}/dispatch/land/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const task3 = DispatchLandTaskSchema.parse(await poll3.json());
      expect(task3.status).toBe("done");
      expect(typeof task3.finished_at).toBe("string");
      expect(task3.result).not.toBeNull();
      expect(task3.error).toBeNull();

      const poll4 = await Bun.fetch(`${h.baseUrl}/dispatch/land/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(DispatchLandTaskSchema.parse(await poll4.json())).toEqual(task3);
    } finally {
      await h.stop();
    }
  });

  test("startLandTask pre-registers a task and is no-op for existing task", async () => {
    const h = await startHarness();
    try {
      h.startLandTask("t-pre");
      const res1 = await Bun.fetch(`${h.baseUrl}/dispatch/land/t-pre`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res1.status).toBe(200);
      const task1 = DispatchLandTaskSchema.parse(await res1.json());
      expect(task1.status).toBe("queued");

      h.startLandTask("t-pre");
      const res2 = await Bun.fetch(`${h.baseUrl}/dispatch/land/t-pre`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const task2 = DispatchLandTaskSchema.parse(await res2.json());
      expect(task2.status).toBe("running");

      const res3 = await Bun.fetch(`${h.baseUrl}/dispatch/land/t-pre`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const task3 = DispatchLandTaskSchema.parse(await res3.json());
      expect(task3.status).toBe("done");
      h.startLandTask("t-pre");
      const res4 = await Bun.fetch(`${h.baseUrl}/dispatch/land/t-pre`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(DispatchLandTaskSchema.parse(await res4.json())).toEqual(task3);
    } finally {
      await h.stop();
    }
  });

  test("GET /dispatch/land/:id returns 404 for unknown task", async () => {
    const h = await startHarness();
    try {
      const res = await Bun.fetch(`${h.baseUrl}/dispatch/land/unknown`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});

describe("seeder replacement and reset", () => {
  test("setHandoffs replaces pending and preserves supplied status/metadata", async () => {
    const h = await startHarness();
    try {
      h.addPendingHandoff({
        handoff_id: "old",
        from_agent: "a",
        to_agent: "b",
        message: "old",
        ts: "2026-01-01T00:00:00Z",
      });
      h.setHandoffs([
        {
          ...baseHarnessRow("new1"),
          status: "dispatched",
          project_id: "p-1",
        },
      ]);
      const res = await Bun.fetch(`${h.baseUrl}/handoffs`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const body = (await res.json()) as { handoffs: { handoff_id: string; status: string }[] };
      expect(body.handoffs).toHaveLength(1);
      expect(body.handoffs[0]!.handoff_id).toBe("new1");
      expect(body.handoffs[0]!.status).toBe("dispatched");
    } finally {
      await h.stop();
    }
  });

  test("reset clears all new state (handoffs, dispatch events, audit, land tasks)", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([{ ...baseHarnessRow("h1"), status: "pending" }]);
      h.setDispatchEvents("h1", [
        {
          handoff_id: "h1",
          worker_id: null,
          source: "daemon",
          kind: "dispatch.start",
          ts: "2026-05-08T00:00:00Z",
          meta: null,
        },
      ]);
      h.setAudit("h1", {
        handoff_id: "h1",
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
      });
      h.startLandTask("t1");

      h.reset();

      const handoffsRes = await Bun.fetch(`${h.baseUrl}/handoffs`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const handoffsBody = (await handoffsRes.json()) as { handoffs: unknown[] };
      expect(handoffsBody.handoffs).toHaveLength(0);

      const eventsRes = await Bun.fetch(`${h.baseUrl}/dispatch/events?handoff_id=h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      const eventsBody = (await eventsRes.json()) as { events: unknown[] };
      expect(eventsBody.events).toHaveLength(0);

      const auditRes = await Bun.fetch(`${h.baseUrl}/dispatch/audit?handoff_id=h1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(auditRes.status).toBe(404);

      const taskRes = await Bun.fetch(`${h.baseUrl}/dispatch/land/t1`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      expect(taskRes.status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});
