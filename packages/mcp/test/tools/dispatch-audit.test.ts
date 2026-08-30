import type { DaemonClient } from "@src/daemon-client.js";

import { DaemonClient as DaemonClientCtor } from "@src/daemon-client.js";
import { dispatchAuditHandler, DispatchAuditInputShape } from "@src/tools/dispatch-audit.js";
import { expect, mock, test } from "bun:test";
import { z } from "zod";

import { connectInMemory, fakeDaemon } from "../helpers.js";

type DispatchAuditFn = DaemonClient["dispatchAudit"];

test("DispatchAuditInputShape requires a handoff_id string", () => {
  const schema = z.object(DispatchAuditInputShape);
  expect(() => schema.parse({})).toThrow();
  expect(() => schema.parse({ handoff_id: "" })).toThrow();
  expect(schema.parse({ handoff_id: "h-1" }).handoff_id).toBe("h-1");
});

test("dispatchAuditHandler delegates to the daemon and returns JSON text content", async () => {
  const audit = {
    report: {
      handoff_id: "h-1",
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
  };
  const dispatchAudit: DispatchAuditFn = mock((handoff_id: string) =>
    Promise.resolve({
      ...audit,
      report: { ...audit.report, handoff_id },
    }),
  );

  const result = await dispatchAuditHandler(fakeDaemon({ dispatchAudit }))({ handoff_id: "h-1" });

  expect(dispatchAudit).toHaveBeenCalledWith("h-1");
  const block = result.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual(audit);
  expect(block.text).toContain('\n  "report"');
});

test("dispatch.audit is registered and forwards through DaemonClient to GET /dispatch/audit", async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedHandoffId: string | null = null;
  const audit = {
    report: {
      handoff_id: "h space",
      status: "no_agent_output",
      terminal: true,
      trustworthy: false,
      summary: "terminal handoff has no agent response",
      missing_events: [],
      evidence: {
        handoff_status: "completed",
        event_count: 4,
        response_count: 0,
        worktree_changed: null,
        reconciled: null,
        watchdog_failed: false,
        cancel_requested: false,
        adapter_streaming: null,
      },
      recommended_action: "review_manually",
    },
  };
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      receivedMethod = req.method;
      receivedPath = url.pathname;
      receivedHandoffId = url.searchParams.get("handoff_id");
      return Response.json(audit);
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;

  try {
    const daemon = new DaemonClientCtor({
      baseUrl: `http://localhost:${String(srv.port)}`,
      token: "t",
    });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "dispatch_audit",
      arguments: { handoff_id: "h space" },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;
    const firstBlock = content[0];
    if (firstBlock === undefined) throw new Error("expected content[0]");

    expect(JSON.parse(firstBlock.text)).toEqual(audit);
    expect(receivedMethod).toBe("GET");
    expect(receivedPath).toBe("/dispatch/audit");
    expect(receivedHandoffId).toBe("h space");
  } finally {
    await client?.close();
    await srv.stop(true);
  }
});
