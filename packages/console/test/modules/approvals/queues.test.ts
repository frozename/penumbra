import type { HandoffRow, PermissionRequestRow, SessionNoteDraft } from "@penumbra/api-contract";

import { describe, expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/api/client";
import {
  approvalsDrafts,
  approvalsHandoffs,
  approvalsPermissions,
  handoffsPending,
  sessionNoteDrafts,
} from "@src/lib/query-keys";
import { type ApprovalItem, QUEUES } from "@src/modules/approvals/queues";
import { draftsQueue } from "@src/modules/approvals/queues/drafts";
import { handoffsQueue } from "@src/modules/approvals/queues/handoffs";
import { permissionsQueue } from "@src/modules/approvals/queues/permissions";

const TS_10 = "2026-09-07T10:00:00.000Z";
const TS_1005 = "2026-09-07T10:05:00.000Z";
const TS_1020 = "2026-09-07T10:20:00.000Z";

function makeHandoff(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoff_id: "h-1",
    ts: TS_1020,
    project_id: null,
    conversation_id: "c-1",
    from_agent: "alpha",
    to_agent: "beta",
    to_role: null,
    message: "handoff 1",
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: false,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    ...overrides,
  };
}

function makePermission(overrides: Partial<PermissionRequestRow> = {}): PermissionRequestRow {
  return {
    permission_id: "p-1",
    parent_handoff_id: "h-parent",
    conversation_id: "c-1",
    agent_name: "claude",
    tool_name: "shell.run",
    raw_input_json: "{}",
    status: "pending",
    remember_scope: null,
    decision_reason: null,
    decided_by: null,
    ttl_at: "2026-09-07T11:00:00.000Z",
    created_at: TS_1005,
    decided_at: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<SessionNoteDraft> = {}): SessionNoteDraft {
  return {
    draft_id: "d-1",
    session_id: "s-1",
    project_id: "penumbra",
    period_key: "2026-09-01-am",
    skeleton_path: "/notes/skeleton.md",
    draft_path: "/notes/draft.md",
    note_path: "/notes/note.md",
    handoff_id: null,
    status: "awaiting_approval",
    composed_at: TS_10,
    reviewed_at: null,
    composed_event_id: 1,
    review_event_id: null,
    ...overrides,
  };
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing action spec");
  return v;
}

const ITEM: ApprovalItem = { id: "h-1", ts: "2026-01-01T00:00:00.000Z", title: "t" };

describe("QUEUES", () => {
  test("registry exposes the three queue kinds in order", () => {
    expect(QUEUES.map((q) => q.kind)).toEqual(["handoff", "permission", "draft"]);
  });
});

describe("handoffsQueue", () => {
  test("fetch lists pending handoffs", async () => {
    const list = mock(() => Promise.resolve({ handoffs: [makeHandoff()] }));
    const client = { handoffs: { list } } as unknown as DaemonClient;
    await handoffsQueue.fetch(client);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ status: "pending" });
  });

  test("item maps id, ts and title from the row", async () => {
    const rows = [makeHandoff({ handoff_id: "h-9", ts: TS_1005, message: "do the thing" })];
    const list = mock(() => Promise.resolve({ handoffs: rows }));
    const client = { handoffs: { list } } as unknown as DaemonClient;
    const items = await handoffsQueue.fetch(client);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("h-9");
    expect(items[0]?.ts).toBe(TS_1005);
    expect(items[0]?.title).toBe("do the thing");
  });

  test("subtitle is exactly from_agent arrow to_agent", async () => {
    const rows = [makeHandoff({ from_agent: "alpha", to_agent: "beta" })];
    const list = mock(() => Promise.resolve({ handoffs: rows }));
    const client = { handoffs: { list } } as unknown as DaemonClient;
    const items = await handoffsQueue.fetch(client);
    expect(items).toHaveLength(1);
    expect(items[0]?.subtitle).toBe("alpha → beta");
  });

  test("approve is safe-tier and calls handoffs.approve with only the id", async () => {
    const approve = mock(() => Promise.resolve({}));
    const client = { handoffs: { approve } } as unknown as DaemonClient;
    const spec = must(handoffsQueue.approve);
    expect(spec.tier).toBe("safe");
    await spec.run(client, { ...ITEM, id: "h-1" }, { signal: new AbortController().signal });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith("h-1");
  });

  test("reject is guarded-tier and calls handoffs.approve with reject and reason", async () => {
    const approve = mock(() => Promise.resolve({}));
    const client = { handoffs: { approve } } as unknown as DaemonClient;
    const spec = must(handoffsQueue.reject);
    expect(spec.tier).toBe("guarded");
    await spec.run(
      client,
      { ...ITEM, id: "h-1" },
      {
        signal: new AbortController().signal,
        reason: "nope",
      },
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith("h-1", { reject: true, reason: "nope" });
  });

  test("approve and reject invalidate pending handoffs plus approvals handoffs", () => {
    expect(must(handoffsQueue.approve).invalidate(ITEM, undefined)).toEqual([
      handoffsPending(),
      approvalsHandoffs(),
    ]);
    expect(must(handoffsQueue.reject).invalidate(ITEM, undefined)).toEqual([
      handoffsPending(),
      approvalsHandoffs(),
    ]);
  });

  test("queryKey is approvalsHandoffs and topic is undefined", () => {
    expect(handoffsQueue.queryKey()).toEqual(approvalsHandoffs());
    expect(handoffsQueue.topic).toBeUndefined();
  });

  test("fetch keeps input order without sorting by ts", async () => {
    const rows = [
      makeHandoff({ handoff_id: "h-late", ts: TS_1020 }),
      makeHandoff({ handoff_id: "h-early", ts: TS_10 }),
    ];
    const list = mock(() => Promise.resolve({ handoffs: rows }));
    const client = { handoffs: { list } } as unknown as DaemonClient;
    const items = await handoffsQueue.fetch(client);
    expect(items.map((i) => i.id)).toEqual(["h-late", "h-early"]);
  });
});

describe("permissionsQueue", () => {
  test("fetch lists pending permissions and maps the item", async () => {
    const rows = [makePermission()];
    const list = mock(() => Promise.resolve({ permissions: rows }));
    const client = { permissions: { list } } as unknown as DaemonClient;
    const items = await permissionsQueue.fetch(client);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ status: "pending" });
    expect(items).toEqual([{ id: "p-1", ts: TS_1005, title: "shell.run", subtitle: "claude" }]);
  });

  test("approve is safe-tier and decides approve", async () => {
    const decide = mock(() => Promise.resolve({}));
    const client = { permissions: { decide } } as unknown as DaemonClient;
    const spec = must(permissionsQueue.approve);
    expect(spec.tier).toBe("safe");
    await spec.run(client, { ...ITEM, id: "p-1" }, { signal: new AbortController().signal });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("p-1", { decision: "approve" });
  });

  test("reject is guarded-tier and decides reject with reason", async () => {
    const decide = mock(() => Promise.resolve({}));
    const client = { permissions: { decide } } as unknown as DaemonClient;
    const spec = must(permissionsQueue.reject);
    expect(spec.tier).toBe("guarded");
    await spec.run(
      client,
      { ...ITEM, id: "p-1" },
      {
        signal: new AbortController().signal,
        reason: "nope",
      },
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("p-1", { decision: "reject", reason: "nope" });
  });

  test("approve and reject invalidate approvals permissions only, and topic is permission-events", () => {
    expect(must(permissionsQueue.approve).invalidate(ITEM, undefined)).toEqual([
      approvalsPermissions(),
    ]);
    expect(must(permissionsQueue.reject).invalidate(ITEM, undefined)).toEqual([
      approvalsPermissions(),
    ]);
    expect(permissionsQueue.topic).toBe("permission-events");
  });
});

describe("draftsQueue", () => {
  test("fetch lists awaiting-approval drafts and maps the item", async () => {
    const rows = [makeDraft()];
    const drafts = mock(() => Promise.resolve({ drafts: rows }));
    const client = { sessionNotes: { drafts } } as unknown as DaemonClient;
    const items = await draftsQueue.fetch(client);
    expect(drafts).toHaveBeenCalledTimes(1);
    expect(drafts).toHaveBeenCalledWith({ status: "awaiting_approval" });
    expect(items).toEqual([
      { id: "d-1", ts: TS_10, title: "2026-09-01-am", subtitle: "/notes/draft.md" },
    ]);
  });

  test("approve is safe-tier, approves the draft and invalidates drafts keys", async () => {
    const approveDraft = mock(() => Promise.resolve({}));
    const client = { sessionNotes: { approve: approveDraft } } as unknown as DaemonClient;
    const spec = must(draftsQueue.approve);
    expect(spec.tier).toBe("safe");
    await spec.run(client, { ...ITEM, id: "d-1" }, { signal: new AbortController().signal });
    expect(approveDraft).toHaveBeenCalledTimes(1);
    expect(approveDraft).toHaveBeenCalledWith({ draft_id: "d-1", approve: true });
    expect(spec.invalidate(ITEM, undefined)).toEqual([sessionNoteDrafts(), approvalsDrafts()]);
  });

  test("drafts queue has no reject action and no topic", () => {
    expect(draftsQueue.reject).toBeUndefined();
    expect(draftsQueue.topic).toBeUndefined();
  });
});
