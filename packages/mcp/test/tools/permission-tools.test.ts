import { describe, expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { permissionApproveHandler } from "@src/tools/permission-approve.js";
import { permissionGetHandler } from "@src/tools/permission-get.js";
import {
  permissionListPendingHandler,
  PermissionListPendingInputShape,
} from "@src/tools/permission-list-pending.js";

import { fakeDaemon } from "../helpers.js";

type ListPermissionsFn = DaemonClient["listPermissions"];
type GetPermissionFn = DaemonClient["getPermission"];
type ApprovePermissionFn = DaemonClient["approvePermission"];

interface FakeDaemonHandles {
  listPermissions: ListPermissionsFn;
  getPermission: GetPermissionFn;
  approvePermission: ApprovePermissionFn;
}

function makeFakeDaemon(overrides: Partial<FakeDaemonHandles> = {}): DaemonClient {
  const listPermissions: ListPermissionsFn = (opts) =>
    Promise.resolve({
      permissions: [{ permission_id: "p-1", requested_at: "t", ...(opts ?? {}) }] as {
        permission_id: string;
        requested_at: string;
      }[],
    });
  const getPermission: GetPermissionFn = (id) =>
    Promise.resolve({
      permission: { permission_id: id, status: "pending", tool_name: "t" },
    });
  const approvePermission: ApprovePermissionFn = (id, body) =>
    Promise.resolve({
      permission_id: id,
      status: body.decision === "approve" ? "approved" : "rejected",
    });
  return fakeDaemon({
    listPermissions: overrides.listPermissions ?? listPermissions,
    getPermission: overrides.getPermission ?? getPermission,
    approvePermission: overrides.approvePermission ?? approvePermission,
  });
}

function firstBlockText(content: { type: string; text: string }[]): string {
  const block = content[0];
  if (block === undefined) throw new Error("expected content[0]");
  return block.text;
}

interface PermissionGetBody {
  permission?: { permission_id: string };
  error?: { code: string; message?: string; hint?: string };
}

describe("permission-list-pending tool", () => {
  test("forwards conversation_id filter to daemon and returns rows", async () => {
    const handler = permissionListPendingHandler(makeFakeDaemon());
    const out = await handler({ conversation_id: "conv-123" });
    const text = firstBlockText(out.content);
    expect(text).toMatch(/^[◌◐●◑] permission_list_pending {2}/);
    expect(text).toContain('"conversation_id": "conv-123"');
  });
  test("input shape declares optional fields", () => {
    expect(PermissionListPendingInputShape).toBeDefined();
  });
});

describe("permission-get tool", () => {
  test("returns the row", async () => {
    const handler = permissionGetHandler(makeFakeDaemon());
    const out = await handler({ permission_id: "p-1" });
    const body = JSON.parse(firstBlockText(out.content)) as PermissionGetBody;
    expect(body.permission?.permission_id).toBe("p-1");
  });
  test("returns 404-shaped body when daemon throws not_found", async () => {
    const getPermission: GetPermissionFn = () =>
      Promise.reject(new DaemonHttpError("daemon /permissions/nope: HTTP 404", 404));
    const handler = permissionGetHandler(makeFakeDaemon({ getPermission }));
    const out = await handler({ permission_id: "nope" });
    const body = JSON.parse(firstBlockText(out.content)) as PermissionGetBody;
    expect(body.error?.code).toBe("not_found");
  });

  test("passes through structured error body from daemon (preserves richer 404 info)", async () => {
    const richBody = {
      error: {
        code: "not_found",
        message: "permission perm-x does not exist",
        hint: "check spelling",
      },
    };
    const getPermission: GetPermissionFn = () =>
      Promise.reject(new DaemonHttpError("daemon: HTTP 404", 404, richBody));
    const handler = permissionGetHandler(makeFakeDaemon({ getPermission }));
    const out = await handler({ permission_id: "perm-x" });
    const body = JSON.parse(firstBlockText(out.content)) as PermissionGetBody;
    expect(body.error?.hint).toBe("check spelling");
  });
});

describe("permission-approve tool", () => {
  test("approve passes through", async () => {
    const handler = permissionApproveHandler(makeFakeDaemon());
    const out = await handler({
      permission_id: "p-1",
      decision: "approve",
      remember: "this_dispatch",
    });
    const text = firstBlockText(out.content);
    expect(text).toMatch(/^[◌◐●◑] permission {2}/);
    expect(text).toContain('"status": "approved"');
  });
  test("reject passes through", async () => {
    const handler = permissionApproveHandler(makeFakeDaemon());
    const out = await handler({
      permission_id: "p-1",
      decision: "reject",
      reason: "no third-party calls",
    });
    const text = firstBlockText(out.content);
    expect(text).toMatch(/^[◌◐●◑] permission {2}/);
    expect(text).toContain('"status": "rejected"');
  });
});
