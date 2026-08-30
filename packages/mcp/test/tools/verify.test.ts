import type { DaemonClient } from "@src/daemon-client.js";

import { verifyHandler, VerifyInputShape } from "@src/tools/verify.js";
import { expect, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type MemoryVerifyFn = DaemonClient["memoryVerify"];
type MemoryVerifyReq = Parameters<MemoryVerifyFn>[0];

test("verify tool input schema rejects invalid provenance identifiers", () => {
  expect(() => VerifyInputShape.by.parse("<script>")).toThrow();
  expect(() => VerifyInputShape.session_id.parse("lane xyz")).toThrow();
  expect(VerifyInputShape.by.parse("agent-name@worktree")).toBe("agent-name@worktree");
  expect(VerifyInputShape.session_id.parse("lane-xyz_1")).toBe("lane-xyz_1");
});

test("verify handler forwards basis to daemon /memory/verify", async () => {
  const calls: MemoryVerifyReq[] = [];
  const memoryVerify: MemoryVerifyFn = (req) => {
    calls.push(req);
    return Promise.resolve({ ok: true });
  };
  const handler = verifyHandler(fakeDaemon({ memoryVerify }));
  await handler({
    memory_id: "m1",
    claimed_by: "agent-name@worktree",
    reason: "manual spot check",
    session_id: "lane-xyz",
    basis: { kind: "manual_override", reason: "approved", authorized_by: "lead" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    memory_id: "m1",
    claimed_by: "agent-name@worktree",
    reason: "manual spot check",
    session_id: "lane-xyz",
    basis: { kind: "manual_override", reason: "approved", authorized_by: "lead" },
  });
});
