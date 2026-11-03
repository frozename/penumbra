import { expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { approveHandoffHandler } from "@src/tools/handoff-approve.js";

import { fakeDaemon } from "../helpers.js";

type ApproveHandoffFn = DaemonClient["approveHandoff"];
type ApproveHandoffBody = Parameters<ApproveHandoffFn>[1];

test("approveHandoffHandler approves and returns status", async () => {
  const received: { id: string; body: ApproveHandoffBody }[] = [];
  const approveHandoff: ApproveHandoffFn = (id, body) => {
    received.push({ id, body });
    return Promise.resolve({ handoff_id: id, status: "approved" });
  };
  const daemon = fakeDaemon({ approveHandoff });
  const handler = approveHandoffHandler(daemon);
  const result = await handler({ handoff_id: "h-1" });
  expect(received).toEqual([{ id: "h-1", body: {} }]);
  const block = result.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(JSON.parse(block.text)).toEqual({ handoff_id: "h-1", status: "approved" });
});

test("approveHandoffHandler forwards redirect_to", async () => {
  const received: ApproveHandoffBody[] = [];
  const approveHandoff: ApproveHandoffFn = (id, body) => {
    received.push(body);
    return Promise.resolve({ handoff_id: id, status: "redirected" });
  };
  const daemon = fakeDaemon({ approveHandoff });
  const handler = approveHandoffHandler(daemon);
  await handler({ handoff_id: "h-1", redirect_to: "codex" });
  expect(received).toEqual([{ redirect_to: "codex" }]);
});
