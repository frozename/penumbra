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
