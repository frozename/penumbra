import { expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { listHandoffsHandler } from "@src/tools/handoff-list.js";

import { fakeDaemon } from "../helpers.js";

type ListPendingHandoffsFn = DaemonClient["listPendingHandoffs"];

test("listHandoffsHandler returns pending list as content", async () => {
  const listPendingHandoffs: ListPendingHandoffsFn = () =>
    Promise.resolve({
      handoffs: [{ handoff_id: "h-1", worker_id: null, status: "pending" }],
    });
  const daemon = fakeDaemon({ listPendingHandoffs });
  const handler = listHandoffsHandler(daemon);
  const result = await handler({});
  const block = result.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(block.text).toMatch(/^[◌◐●◑] handoff_list_pending {2}/);
  expect(block.text).toContain('"handoff_id": "h-1"');
});
