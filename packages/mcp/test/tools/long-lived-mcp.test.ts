import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { longLivedApproveActionHandler } from "../../src/tools/long-lived-approve-action-mcp.js";
import { longLivedAuditHandler } from "../../src/tools/long-lived-audit-mcp.js";
import { longLivedGetHandler } from "../../src/tools/long-lived-get-mcp.js";
import { longLivedInjectGoalHandler } from "../../src/tools/long-lived-inject-goal-mcp.js";
import { longLivedListHandler } from "../../src/tools/long-lived-list-mcp.js";
import { longLivedPauseHandler } from "../../src/tools/long-lived-pause-mcp.js";
import {
  longLivedPendingActionsHandler,
  LongLivedPendingActionsInputShape,
} from "../../src/tools/long-lived-pending-actions-mcp.js";
import { longLivedRejectActionHandler } from "../../src/tools/long-lived-reject-action-mcp.js";
import { longLivedResumeHandler } from "../../src/tools/long-lived-resume-mcp.js";
import { longLivedRetireHandler } from "../../src/tools/long-lived-retire-mcp.js";
import { longLivedStateGetHandler } from "../../src/tools/long-lived-state-get-mcp.js";
import { longLivedStateSetHandler } from "../../src/tools/long-lived-state-set-mcp.js";
import { longLivedTicksHandler } from "../../src/tools/long-lived-ticks-mcp.js";
import { fakeDaemon } from "../helpers.js";

type LongLivedListFn = DaemonClient["longLivedList"];
type LongLivedGetFn = DaemonClient["longLivedGet"];
type LongLivedPauseFn = DaemonClient["longLivedPause"];
type LongLivedResumeFn = DaemonClient["longLivedResume"];
type LongLivedRetireFn = DaemonClient["longLivedRetire"];
type LongLivedStateGetFn = DaemonClient["longLivedStateGet"];
type LongLivedStateSetFn = DaemonClient["longLivedStateSet"];
type LongLivedPendingActionsFn = DaemonClient["longLivedPendingActions"];
type LongLivedApproveActionFn = DaemonClient["longLivedApproveAction"];
type LongLivedRejectActionFn = DaemonClient["longLivedRejectAction"];
type LongLivedInjectGoalFn = DaemonClient["longLivedInjectGoal"];
type LongLivedAuditFn = DaemonClient["longLivedAudit"];
type LongLivedTicksFn = DaemonClient["longLivedTicks"];

test("long_lived_list proxies to daemon.longLivedList", async () => {
  const longLivedList = mock<LongLivedListFn>(() => Promise.resolve({ agents: [{ id: "a" }] }));
  const result = await longLivedListHandler(fakeDaemon({ longLivedList }))();
  expect(longLivedList).toHaveBeenCalledTimes(1);
  const block = result.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  expect(block.text).toContain('"agents"');
});

test("long_lived_get proxies to daemon.longLivedGet", async () => {
  const longLivedGet = mock<LongLivedGetFn>(() => Promise.resolve({ agent: { id: "a" } }));
  await longLivedGetHandler(fakeDaemon({ longLivedGet }))({ id: "a" });
  expect(longLivedGet).toHaveBeenCalledWith("a");
});

test("long_lived_pause proxies to daemon.longLivedPause", async () => {
  const longLivedPause = mock<LongLivedPauseFn>(() =>
    Promise.resolve({ id: "a", status: "paused" }),
  );
  await longLivedPauseHandler(fakeDaemon({ longLivedPause }))({ id: "a" });
  expect(longLivedPause).toHaveBeenCalledWith("a");
});

test("long_lived_resume proxies to daemon.longLivedResume", async () => {
  const longLivedResume = mock<LongLivedResumeFn>(() =>
    Promise.resolve({ id: "a", status: "active" }),
  );
  await longLivedResumeHandler(fakeDaemon({ longLivedResume }))({ id: "a" });
  expect(longLivedResume).toHaveBeenCalledWith("a");
});

test("long_lived_retire proxies to daemon.longLivedRetire", async () => {
  const longLivedRetire = mock<LongLivedRetireFn>(() =>
    Promise.resolve({ id: "a", status: "retired" }),
  );
  await longLivedRetireHandler(fakeDaemon({ longLivedRetire }))({ id: "a" });
  expect(longLivedRetire).toHaveBeenCalledWith("a");
});

test("long_lived_state_get proxies to daemon.longLivedStateGet", async () => {
  const longLivedStateGet = mock<LongLivedStateGetFn>(() =>
    Promise.resolve({ working_memory: {} }),
  );
  await longLivedStateGetHandler(fakeDaemon({ longLivedStateGet }))({ id: "a" });
  expect(longLivedStateGet).toHaveBeenCalledWith("a");
});

test("long_lived_state_set proxies to daemon.longLivedStateSet", async () => {
  const longLivedStateSet = mock<LongLivedStateSetFn>(() => Promise.resolve({ ok: true }));
  await longLivedStateSetHandler(fakeDaemon({ longLivedStateSet }))({
    id: "a",
    partial: { intent_summary: "x" },
  });
  expect(longLivedStateSet).toHaveBeenCalledWith("a", { intent_summary: "x" });
});

test("long_lived_pending_actions proxies to daemon.longLivedPendingActions", async () => {
  const longLivedPendingActions = mock<LongLivedPendingActionsFn>(() =>
    Promise.resolve({ pending_actions: [] }),
  );
  await longLivedPendingActionsHandler(fakeDaemon({ longLivedPendingActions }))({
    id: "a",
    status: "pending",
  });
  expect(longLivedPendingActions).toHaveBeenCalledWith("a", "pending");
});

test("long_lived_pending_actions requires id", () => {
  expect(LongLivedPendingActionsInputShape.id.safeParse(undefined).success).toBe(false);
});

test("long_lived_approve_action proxies to daemon.longLivedApproveAction", async () => {
  const longLivedApproveAction = mock<LongLivedApproveActionFn>(() =>
    Promise.resolve({ ok: true }),
  );
  await longLivedApproveActionHandler(fakeDaemon({ longLivedApproveAction }))({ action_id: "x" });
  expect(longLivedApproveAction).toHaveBeenCalledWith("x", undefined);
});

test("long_lived_approve_action forwards decided_by", async () => {
  const longLivedApproveAction = mock<LongLivedApproveActionFn>(() =>
    Promise.resolve({ ok: true }),
  );
  await longLivedApproveActionHandler(fakeDaemon({ longLivedApproveAction }))({
    action_id: "x",
    decided_by: "maestro:foo",
  });
  expect(longLivedApproveAction).toHaveBeenCalledWith("x", "maestro:foo");
});

test("long_lived_reject_action proxies to daemon.longLivedRejectAction", async () => {
  const longLivedRejectAction = mock<LongLivedRejectActionFn>(() => Promise.resolve({ ok: true }));
  await longLivedRejectActionHandler(fakeDaemon({ longLivedRejectAction }))({
    action_id: "x",
    reason: "no",
  });
  expect(longLivedRejectAction).toHaveBeenCalledWith("x", "no", undefined);
});

test("long_lived_reject_action forwards decided_by and reason", async () => {
  const longLivedRejectAction = mock<LongLivedRejectActionFn>(() => Promise.resolve({ ok: true }));
  await longLivedRejectActionHandler(fakeDaemon({ longLivedRejectAction }))({
    action_id: "x",
    reason: "no",
    decided_by: "maestro:foo",
  });
  expect(longLivedRejectAction).toHaveBeenCalledWith("x", "no", "maestro:foo");
});

test("long_lived_inject_goal proxies to daemon.longLivedInjectGoal", async () => {
  const longLivedInjectGoal = mock<LongLivedInjectGoalFn>(() => Promise.resolve({ ok: true }));
  await longLivedInjectGoalHandler(fakeDaemon({ longLivedInjectGoal }))({
    id: "a",
    goal: "do thing",
  });
  expect(longLivedInjectGoal).toHaveBeenCalledWith("a", "do thing");
});

test("long_lived_audit proxies to daemon.longLivedAudit", async () => {
  const longLivedAudit = mock<LongLivedAuditFn>(() => Promise.resolve({ audit: [] }));
  await longLivedAuditHandler(fakeDaemon({ longLivedAudit }))({ id: "a", since: 10, limit: 5 });
  expect(longLivedAudit).toHaveBeenCalledWith("a", 10, 5);
});

test("long_lived_ticks proxies to daemon.longLivedTicks", async () => {
  const longLivedTicks = mock<LongLivedTicksFn>(() => Promise.resolve({ ticks: [] }));
  await longLivedTicksHandler(fakeDaemon({ longLivedTicks }))({ id: "a", since: 10, limit: 5 });
  expect(longLivedTicks).toHaveBeenCalledWith("a", 10, 5);
});
