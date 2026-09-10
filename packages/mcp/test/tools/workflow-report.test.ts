import { expect, mock, test } from "bun:test";
import { ZodError } from "zod";

import type { DaemonClient } from "@src/daemon-client.js";
import { workflowReportHandler } from "@src/tools/workflow-report.js";

import { fakeDaemon } from "../helpers.js";

type WorkflowReportFn = DaemonClient["workflowReport"];

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

test("passes filters to daemon.workflowReport and returns wrapped text content", async () => {
  const workflowReport = mock<WorkflowReportFn>(() =>
    Promise.resolve({
      window: {
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-08T00:00:00.000Z",
        hours: 168,
      },
      rows: [],
    }),
  );
  const handler = workflowReportHandler(fakeDaemon({ workflowReport }));
  const result = await handler({ window_hours: 24, project_id: "proj/a b" });

  expect(workflowReport).toHaveBeenCalledWith({ window_hours: 24, project_id: "proj/a b" });
  const block = result.content[0];
  if (!block) throw new Error("expected content[0]");
  expect(JSON.parse(block.text)).toEqual({
    window: {
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-08T00:00:00.000Z",
      hours: 168,
    },
    rows: [],
  });
});

test("rejects empty project ids and non-integer windows before daemon call", async () => {
  const workflowReport = mock<WorkflowReportFn>(() => Promise.resolve({ window: {}, rows: [] }));
  const handler = workflowReportHandler(fakeDaemon({ workflowReport }));

  expect(await captureRejection(handler({ project_id: "" }))).toBeInstanceOf(ZodError);
  expect(await captureRejection(handler({ window_hours: 1.5 }))).toBeInstanceOf(ZodError);
  expect(await captureRejection(handler({ window_hours: 2161 }))).toBeInstanceOf(ZodError);
  expect(workflowReport).not.toHaveBeenCalled();
});

test("transport failures follow sibling handler behavior", async () => {
  const handler = workflowReportHandler(
    fakeDaemon({
      workflowReport: mock<WorkflowReportFn>(() => Promise.reject(new Error("daemon down"))),
    }),
  );

  const err = await captureRejection(handler({ window_hours: 24 }));
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("daemon down");
});
