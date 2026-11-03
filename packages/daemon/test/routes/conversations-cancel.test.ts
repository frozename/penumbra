import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { conversationsCancelRoute } from "@src/routes/conversations.js";
import { handoffsCreateRoute } from "@src/routes/handoffs.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface CancelTestEvent {
  type: string;
  conversation_id?: string;
  handoff_id?: string;
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/conversations-cancel-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (() => {
      let t = new Date("2026-04-26T00:00:00Z").getTime();
      return () => {
        t += 1000;
        return new Date(t);
      };
    })(),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `e-${String(n)}`;
      };
    })(),
  });
}

test("cancel broadcasts to dispatched handoffs in the conversation", async () => {
  const services = tempServices();
  const cid = "conv-dispatched";

  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e-dispatched",
      }),
    }),
    services,
  );
  services.handoffWriter.approve("e-1", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.claimDispatch("e-1", "worker-1");

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect<CancelTestEvent | null>(emitted).toEqual({
    type: "cancel",
    conversation_id: cid,
    handoff_id: "e-1",
  });
});

test("cancel broadcasts to approved handoffs when no dispatched handoffs exist", async () => {
  const services = tempServices();
  const cid = "conv-approved";

  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e-approved",
      }),
    }),
    services,
  );
  services.handoffWriter.approve("e-1", { resolved_by: "u", resolved_at: "approved-ts" });

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect<CancelTestEvent | null>(emitted).toEqual({
    type: "cancel",
    conversation_id: cid,
    handoff_id: "e-1",
  });
});

test("cancel broadcasts to pending handoffs when no dispatched/approved handoffs exist", async () => {
  const services = tempServices();
  const cid = "conv-pending";

  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e-pending",
      }),
    }),
    services,
  );

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect<CancelTestEvent | null>(emitted).toEqual({
    type: "cancel",
    conversation_id: cid,
    handoff_id: "e-1",
  });
});

test("cancel emits for every dispatched handoff in the conversation", async () => {
  const services = tempServices();
  const cid = "conv-multi-dispatched";

  for (const [id, message] of [
    ["e-m1", "m1"],
    ["e-m2", "m2"],
  ] as const) {
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message,
          conversation_id: cid,
          triggered_by_event_id: id,
        }),
      }),
      services,
    );
  }
  services.handoffWriter.approve("e-1", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.approve("e-2", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.claimDispatch("e-1", "worker-1");
  services.handoffWriter.claimDispatch("e-2", "worker-2");

  const emitted: CancelTestEvent[] = [];
  services.workerControl.subscribe((event) => {
    emitted.push(event);
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect(emitted).toEqual([
    { type: "cancel", conversation_id: cid, handoff_id: "e-1" },
    { type: "cancel", conversation_id: cid, handoff_id: "e-2" },
  ]);
});

test("cancel fallback targets the most recent eligible handoff", async () => {
  const services = tempServices();
  const cid = "conv-latest-eligible";

  for (const [id, message] of [
    ["e-l1", "m1"],
    ["e-l2", "m2"],
  ] as const) {
    await handoffsCreateRoute(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message,
          conversation_id: cid,
          triggered_by_event_id: id,
        }),
      }),
      services,
    );
  }
  services.handoffWriter.approve("e-1", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.approve("e-2", { resolved_by: "u", resolved_at: "approved-ts" });

  const eligible = services.handoffReader.listByStatus({
    statuses: ["approved", "redirected", "pending"],
    conversation_id: cid,
  });
  expect(eligible.map((row) => row.handoff_id)).toEqual(["e-1", "e-2"]);

  const emitted: CancelTestEvent[] = [];
  services.workerControl.subscribe((event) => {
    emitted.push(event);
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect(emitted).toEqual([{ type: "cancel", conversation_id: cid, handoff_id: "e-2" }]);
});

test("cancel fallback broadcasts to a redirected-only conversation", async () => {
  const services = tempServices();
  const cid = "conv-redirected";

  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e-redirected",
      }),
    }),
    services,
  );
  services.handoffWriter.approve("e-1", {
    resolved_by: "u",
    resolved_at: "approved-ts",
    redirect_to: "c",
  });
  expect(services.handoffReader.get("e-1")?.status).toBe("redirected");

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect<CancelTestEvent | null>(emitted).toEqual({
    type: "cancel",
    conversation_id: cid,
    handoff_id: "e-1",
  });
});

test("cancel returns changed=false when no matching handoffs exist", async () => {
  const services = tempServices();
  const cid = "conv-nonexistent";

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(false);
  expect<CancelTestEvent | null>(emitted).toBeNull();
});

test("cancel is scoped to conversation_id — other conversations are unaffected", async () => {
  const services = tempServices();

  // First conversation: create a dispatched handoff
  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m1",
        conversation_id: "conv-a",
        triggered_by_event_id: "e-a",
      }),
    }),
    services,
  );
  services.handoffWriter.approve("e-1", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.claimDispatch("e-1", "worker-1");

  // Second conversation: create a dispatched handoff
  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m2",
        conversation_id: "conv-b",
        triggered_by_event_id: "e-b",
      }),
    }),
    services,
  );
  services.handoffWriter.approve("e-2", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.claimDispatch("e-2", "worker-2");

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  // Cancel only conv-a — should NOT emit for conv-b
  const res = conversationsCancelRoute(new Request("http://x"), "conv-a", services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(true);
  expect<CancelTestEvent | null>(emitted).toEqual({
    type: "cancel",
    conversation_id: "conv-a",
    handoff_id: "e-1",
  });

  // Verify conv-b's handoff is still dispatched and uncancelled
  const convBRows = services.handoffReader.listByStatus({
    statuses: ["dispatched"],
    conversation_id: "conv-b",
  });
  expect(convBRows).toHaveLength(1);
  expect(convBRows[0]!.cancel_requested_at).toBeNull();
});

test("cancel on conversation with only non-cancellable handoffs returns changed=false", async () => {
  const services = tempServices();
  const cid = "conv-only-rejected";

  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e-rejected",
      }),
    }),
    services,
  );
  services.handoffWriter.reject("e-1", {
    resolved_by: "u",
    resolved_at: "rejected-ts",
    reason: "nope",
  });

  let emitted: CancelTestEvent | null = null;
  services.workerControl.subscribe((event) => {
    emitted = event;
  });

  const res = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; changed: boolean };
  expect(body.ok).toBe(true);
  expect(body.changed).toBe(false);
  expect<CancelTestEvent | null>(emitted).toBeNull();
});

test("repeat cancel on same conversation returns changed=false but still broadcasts", async () => {
  const services = tempServices();
  const cid = "conv-repeat";

  await handoffsCreateRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: cid,
        triggered_by_event_id: "e-repeat",
      }),
    }),
    services,
  );
  services.handoffWriter.approve("e-1", { resolved_by: "u", resolved_at: "approved-ts" });
  services.handoffWriter.claimDispatch("e-1", "worker-1");

  const emitted: CancelTestEvent[] = [];
  services.workerControl.subscribe((event) => {
    emitted.push(event);
  });

  // First cancel
  const res1 = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res1.status).toBe(200);
  const body1 = (await res1.json()) as { ok: boolean; changed: boolean };
  expect(body1.ok).toBe(true);
  expect(body1.changed).toBe(true);
  expect(emitted).toEqual([
    {
      type: "cancel",
      conversation_id: cid,
      handoff_id: "e-1",
    },
  ]);

  // Second cancel on same conversation — DB update returns changed=false because
  // cancel_requested_at is already set, but the broadcast still fires because the
  // route emits based on the presence of matching handoff rows, not on changed.
  const res2 = conversationsCancelRoute(new Request("http://x"), cid, services);
  expect(res2.status).toBe(200);
  const body2 = (await res2.json()) as { ok: boolean; changed: boolean };
  expect(body2.ok).toBe(true);
  expect(body2.changed).toBe(false);
  expect(emitted).toEqual([
    {
      type: "cancel",
      conversation_id: cid,
      handoff_id: "e-1",
    },
    {
      type: "cancel",
      conversation_id: cid,
      handoff_id: "e-1",
    },
  ]);
});
