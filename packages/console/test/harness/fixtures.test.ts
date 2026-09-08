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
