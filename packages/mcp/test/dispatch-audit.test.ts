import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "../src/daemon-client.js";

import { dispatchAuditHandler } from "../src/tools/dispatch-audit.js";

type AuditDaemon = Pick<DaemonClient, "dispatchAudit">;

function makeAudit(handoff_id: string): Awaited<ReturnType<DaemonClient["dispatchAudit"]>> {
  return {
    report: {
      handoff_id,
      status: "complete",
      terminal: true,
      trustworthy: true,
      summary: "dispatch lifecycle and result evidence are complete",
      missing_events: [],
      evidence: {
        handoff_status: "completed",
        event_count: 4,
        response_count: 1,
        worktree_changed: true,
        reconciled: true,
        watchdog_failed: false,
        cancel_requested: false,
        adapter_streaming: true,
      },
      recommended_action: "accept",
    },
  } as unknown as Awaited<ReturnType<DaemonClient["dispatchAudit"]>>;
}

test("dispatchAuditHandler calls the daemon once with the supplied handoff_id", async () => {
  const calls: string[] = [];
  const daemon: AuditDaemon = {
    dispatchAudit: mock((handoff_id: string) => {
      calls.push(handoff_id);
      return Promise.resolve(makeAudit(handoff_id));
    }),
  };

  const handler = dispatchAuditHandler(daemon);
  await handler({ handoff_id: "h-1" });

  expect(daemon.dispatchAudit).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(["h-1"]);
});

test("dispatchAuditHandler wraps the daemon response in a text content envelope", async () => {
  const audit = makeAudit("h-1");
  const daemon: AuditDaemon = {
    dispatchAudit: mock(() => Promise.resolve(audit)),
  };
  const handler = dispatchAuditHandler(daemon);

  const result = await handler({ handoff_id: "h-1" });

  expect(result).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify(audit, null, 2),
      },
    ],
  });
  expect(JSON.parse(result.content[0]!.text) as unknown).toEqual(audit);
});

test("dispatchAuditHandler propagates daemon errors", async () => {
  const daemon: AuditDaemon = {
    dispatchAudit: mock(() => Promise.reject(new Error("404 not found"))),
  };
  const handler = dispatchAuditHandler(daemon);

  let thrown: unknown = null;
  try {
    await handler({ handoff_id: "missing-handoff" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("404 not found");
});
