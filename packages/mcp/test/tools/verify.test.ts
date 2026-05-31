import { expect, test } from "bun:test";
import { VerifyInputShape, verifyHandler } from "../../src/tools/verify.js";

test("verify tool input schema rejects invalid provenance identifiers", () => {
  expect(() => VerifyInputShape.by!.parse("<script>")).toThrow();
  expect(() => VerifyInputShape.session_id!.parse("lane xyz")).toThrow();
  expect(VerifyInputShape.by!.parse("agent-name@worktree")).toBe("agent-name@worktree");
  expect(VerifyInputShape.session_id!.parse("lane-xyz_1")).toBe("lane-xyz_1");
});

test("verify handler forwards basis to daemon /memory/verify", async () => {
  const calls: unknown[] = [];
  const handler = verifyHandler({
    memoryVerify: async (req: unknown) => {
      calls.push(req);
      return { ok: true };
    },
  } as any);
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
