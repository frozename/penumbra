import { describe, expect, test } from "bun:test";

import { handoffsSlice } from "@src/api/domains/handoffs.js";
import { DaemonTransport } from "@src/api/transport.js";

// eslint-disable-next-line no-restricted-imports -- the harness lives outside src
import type { HarnessRow } from "../../e2e/harness/server";

// eslint-disable-next-line no-restricted-imports -- the harness lives outside src
import { startHarness } from "../../e2e/harness/index";

const BASE_TS = Date.parse("2026-05-08T00:00:00.000Z");

function baseRow(
  id: string,
  overrides: Partial<HarnessRow> & { conversation_id?: string } = {},
): HarnessRow {
  return {
    handoff_id: id,
    from_agent: "a",
    to_agent: "b",
    message: "m",
    ts: new Date(BASE_TS).toISOString(),
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
    status: "pending",
    ...overrides,
  };
}

function atSecond(offsetSeconds: number): string {
  return new Date(BASE_TS + offsetSeconds * 1000).toISOString();
}

async function authFetch(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return await Bun.fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
}

describe("handoffs conversation fixture", () => {
  test("GET /handoffs/latest returns the newest ts for the requested conversation", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([
        baseRow("h1", { status: "dispatched", ts: atSecond(1), conversation_id: "c1" }),
        baseRow("h2", { status: "completed", ts: atSecond(2), conversation_id: "c1" }),
        baseRow("h3", { status: "dispatched", ts: atSecond(3), conversation_id: "c2" }),
      ]);

      const res = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { handoff: { handoff_id: string } };
      expect(body.handoff.handoff_id).toBe("h2");
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest handles percent/slash/space conversation id", async () => {
    const conversationId = "c%2F a/b";
    const h = await startHarness();
    try {
      h.setHandoffs([
        baseRow("h1", {
          status: "dispatched",
          ts: atSecond(1),
          conversation_id: conversationId,
        }),
      ]);

      const res = await authFetch(
        h.baseUrl,
        h.token,
        `/handoffs/latest?conversation_id=${encodeURIComponent(conversationId)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        handoff: { handoff_id: string; conversation_id: string };
      };
      expect(body.handoff.handoff_id).toBe("h1");
      expect(body.handoff.conversation_id).toBe(conversationId);
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest matches before dynamic /handoffs/:id", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([baseRow("latest", { status: "dispatched", ts: atSecond(1) })]);
      const res = await authFetch(h.baseUrl, h.token, "/handoffs/latest");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("missing_param");
      expect(body.error.message).toContain("conversation_id");
      expect(body).toEqual({
        error: { code: "missing_param", message: "conversation_id query parameter is required" },
      });
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest rejects missing or empty conversation_id with 400", async () => {
    const h = await startHarness();
    try {
      const missing = await authFetch(h.baseUrl, h.token, "/handoffs/latest");
      expect(missing.status).toBe(400);
      const missingBody = (await missing.json()) as { error: { code: string; message: string } };
      expect(missingBody.error.code).toBe("missing_param");
      expect(missingBody).toEqual({
        error: { code: "missing_param", message: "conversation_id query parameter is required" },
      });

      const empty = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=");
      expect(empty.status).toBe(400);
      const emptyBody = (await empty.json()) as { error: { code: string; message: string } };
      expect(emptyBody.error.code).toBe("missing_param");
      expect(emptyBody).toEqual({
        error: { code: "missing_param", message: "conversation_id query parameter is required" },
      });
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest returns 404 when no handoffs match the conversation", async () => {
    const h = await startHarness();
    try {
      const res = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=none");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toContain("conversation");
      expect(body).toEqual({
        error: { code: "not_found", message: "no handoffs found for conversation" },
      });
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs filters by conversation_id combined with status/agent/project_id", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([
        baseRow("h1", {
          status: "pending",
          ts: atSecond(1),
          conversation_id: "c1",
          to_agent: "claude",
          project_id: "p-1",
        }),
        baseRow("h2", {
          status: "dispatched",
          ts: atSecond(2),
          conversation_id: "c1",
          to_agent: "gemini",
          project_id: "p-2",
        }),
        baseRow("h3", {
          status: "pending",
          ts: atSecond(3),
          conversation_id: "c2",
          to_agent: "claude",
          project_id: "p-1",
        }),
        baseRow("h4", {
          status: "dispatched",
          ts: atSecond(4),
          conversation_id: "c1",
          to_agent: "gemini",
          project_id: "p-2",
        }),
      ]);

      const res = await authFetch(
        h.baseUrl,
        h.token,
        "/handoffs?conversation_id=c1&status=dispatched&agent=gemini&project_id=p-2",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { handoffs: { handoff_id: string }[] };
      const ids = body.handoffs.map((r) => r.handoff_id).sort();
      expect(ids).toEqual(["h2", "h4"]);
    } finally {
      await h.stop();
    }
  });

  test("setHandoffs replacing seeds updates latest and reset clears it", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([baseRow("h1", { status: "dispatched", ts: atSecond(1) })]);
      const first = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { handoff: { handoff_id: string } };
      expect(firstBody.handoff.handoff_id).toBe("h1");

      h.setHandoffs([baseRow("h2", { status: "dispatched", ts: atSecond(2) })]);
      const second = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { handoff: { handoff_id: string } };
      expect(secondBody.handoff.handoff_id).toBe("h2");

      h.reset();
      const third = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(third.status).toBe(404);
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest does not mutate the seed order", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([
        baseRow("h1", { status: "pending", ts: atSecond(1) }),
        baseRow("h2", { status: "pending", ts: atSecond(2) }),
        baseRow("h3", { status: "pending", ts: atSecond(3) }),
      ]);

      const latest = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(latest.status).toBe(200);

      const list = await authFetch(h.baseUrl, h.token, "/handoffs?conversation_id=c1");
      const body = (await list.json()) as { handoffs: { handoff_id: string }[] };
      expect(body.handoffs.map((r) => r.handoff_id)).toEqual(["h1", "h2", "h3"]);
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest with more than 500 historical rows returns the newest unique row", async () => {
    const h = await startHarness();
    try {
      const rows: HarnessRow[] = [];
      for (let i = 0; i < 505; i++) {
        rows.push(
          baseRow(`h-old-${String(i)}`, {
            status: i % 2 === 0 ? "pending" : "completed",
            ts: new Date(BASE_TS + i * 1000).toISOString(),
          }),
        );
      }
      rows.push(
        baseRow("h-new", {
          status: "dispatched",
          ts: new Date(BASE_TS + 505 * 1000).toISOString(),
        }),
      );
      h.setHandoffs(rows);

      const res = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { handoff: { handoff_id: string } };
      expect(body.handoff.handoff_id).toBe("h-new");
    } finally {
      await h.stop();
    }
  });

  test("GET /handoffs/latest uses SQLite TEXT ordering for timestamp offsets", async () => {
    const h = await startHarness();
    try {
      h.setHandoffs([
        baseRow("plus", { ts: "2026-01-01T00:00:00+01:00" }),
        baseRow("minus", { ts: "2026-01-01T00:00:00-01:00" }),
      ]);
      const res = await authFetch(h.baseUrl, h.token, "/handoffs/latest?conversation_id=c1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { handoff: { handoff_id: string; ts: string } };
      expect(body.handoff.handoff_id).toBe("minus");
      expect(body.handoff.ts).toBe("2026-01-01T00:00:00-01:00");
    } finally {
      await h.stop();
    }
  });

  test("handoffs client latest and filtered list roundtrip encoded conversation beyond 500 old rows", async () => {
    const h = await startHarness();
    const conversationId = "c%2F a/b";
    try {
      const rows = Array.from({ length: 505 }, (_, index) =>
        baseRow(`h-old-${String(index)}`, {
          conversation_id: conversationId,
          status: "completed",
          ts: atSecond(index),
          to_agent: "claude",
          project_id: "p-current",
        }),
      );
      const latestRow = baseRow("h-current", {
        conversation_id: conversationId,
        status: "dispatched",
        ts: atSecond(600),
        to_agent: "claude",
        project_id: "p-current",
      });
      h.setHandoffs([
        ...rows,
        baseRow("h-wrong-agent", {
          conversation_id: conversationId,
          status: "dispatched",
          ts: atSecond(510),
          to_agent: "gemini",
          project_id: "p-current",
        }),
        baseRow("h-wrong-project", {
          conversation_id: conversationId,
          status: "dispatched",
          ts: atSecond(520),
          to_agent: "claude",
          project_id: "p-other",
        }),
        latestRow,
        baseRow("h-decoded-conversation", {
          conversation_id: "c/ a/b",
          status: "dispatched",
          ts: atSecond(700),
          to_agent: "claude",
          project_id: "p-current",
        }),
      ]);
      const client = handoffsSlice(
        new DaemonTransport({
          fetch: Bun.fetch.bind(Bun),
          getConfig: (): { baseUrl: string; token: string } => ({
            baseUrl: h.baseUrl,
            token: h.token,
          }),
        }),
      );

      const latest = await client.latest(conversationId);
      expect(latest.handoff.handoff_id).toBe(latestRow.handoff_id);
      expect(latest.handoff.conversation_id).toBe(conversationId);
      expect(latest.handoff.ts).toBe(latestRow.ts);

      const active = await client.list({
        conversationId,
        status: "dispatched",
        agent: "claude",
        projectId: "p-current",
      });
      expect(active.handoffs).toHaveLength(1);
      expect(active.handoffs[0]!.handoff_id).toBe(latestRow.handoff_id);
      expect(active.handoffs[0]!.conversation_id).toBe(conversationId);
    } finally {
      await h.stop();
    }
  });
});
