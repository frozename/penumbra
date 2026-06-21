import { expect, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { planListHandler } from "../../src/tools/plan-list.js";
import { planStatusHandler } from "../../src/tools/plan-status.js";
import { fakeDaemon } from "../helpers.js";

type PlanListFn = DaemonClient["planList"];
type PlanListReq = Parameters<PlanListFn>[0];
type PlanListResult = Awaited<ReturnType<PlanListFn>>;
type PlanStatusFn = DaemonClient["planStatus"];
type PlanStatusReq = Parameters<PlanStatusFn>[0];
type PlanStatusResult = Awaited<ReturnType<PlanStatusFn>>;

interface TextEnvelope {
  content: { type: string; text: string }[];
}

function envelopeText(result: TextEnvelope): string {
  const block = result.content[0];
  if (!block) {
    throw new Error("expected envelope content[0]");
  }
  return block.text;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("plan.list returns all plans when no status filter", async () => {
  const planList: PlanListFn = (): Promise<PlanListResult> =>
    Promise.resolve({
      plans: [
        {
          plan_id: "a-1",
          file_path: "/a.md",
          home_project: "penumbra",
          registered_at: 1700000000,
          status: "running",
        },
        {
          plan_id: "b-2",
          file_path: "/b.md",
          home_project: "sirius",
          registered_at: 1700000001,
          status: "completed",
        },
      ],
    });
  const handler = planListHandler(fakeDaemon({ planList }));
  const result = await handler({});
  expect(JSON.parse(envelopeText(result)) as PlanListResult).toEqual({
    plans: [
      {
        plan_id: "a-1",
        file_path: "/a.md",
        home_project: "penumbra",
        registered_at: 1700000000,
        status: "running",
      },
      {
        plan_id: "b-2",
        file_path: "/b.md",
        home_project: "sirius",
        registered_at: 1700000001,
        status: "completed",
      },
    ],
  });
});

test("plan.list filters by status", async () => {
  const planList: PlanListFn = (req: PlanListReq): Promise<PlanListResult> => {
    expect(req.status).toBe("running");
    return Promise.resolve({
      plans: [
        {
          plan_id: "a-1",
          file_path: "/a.md",
          home_project: "penumbra",
          registered_at: 1700000000,
          status: "running",
        },
      ],
    });
  };
  const handler = planListHandler(fakeDaemon({ planList }));
  const result = await handler({ status: "running" });
  expect(JSON.parse(envelopeText(result)) as PlanListResult).toEqual({
    plans: [
      {
        plan_id: "a-1",
        file_path: "/a.md",
        home_project: "penumbra",
        registered_at: 1700000000,
        status: "running",
      },
    ],
  });
});

test("plan.list rejects invalid status", async () => {
  const planList: PlanListFn = (): Promise<PlanListResult> => Promise.resolve({ plans: [] });
  const handler = planListHandler(fakeDaemon({ planList }));
  const err = await captureRejection(handler({ status: "bogus" }));
  expect(err).toBeInstanceOf(Error);
});

test("plan.status returns plan + hydrated tasks", async () => {
  const planStatus: PlanStatusFn = (req: PlanStatusReq): Promise<PlanStatusResult> =>
    Promise.resolve({
      plan: {
        plan_id: req.plan_id,
        file_path: "/a.md",
        home_project: "penumbra",
        registered_at: 1700000000,
        status: "running",
      },
      tasks: [
        {
          plan_id: req.plan_id,
          task_meta_id: "1.1",
          project_id: "penumbra",
          task_id_in_board: "task-abc",
          status: "running",
          last_event_ts: 1700000005,
        },
      ],
    });
  const handler = planStatusHandler(fakeDaemon({ planStatus }));
  const result = await handler({ plan_id: "a-1" });
  const payload = JSON.parse(envelopeText(result)) as PlanStatusResult;
  expect(payload.plan.plan_id).toBe("a-1");
  expect(payload.tasks[0]?.task_id_in_board).toBe("task-abc");
});
