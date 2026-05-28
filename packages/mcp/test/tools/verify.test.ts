import { expect, test } from "bun:test";
import { VerifyInputShape } from "../../src/tools/verify.js";

test("verify tool input schema rejects invalid provenance identifiers", () => {
  expect(() => VerifyInputShape.by!.parse("<script>")).toThrow();
  expect(() => VerifyInputShape.session_id!.parse("lane xyz")).toThrow();
  expect(VerifyInputShape.by!.parse("agent-name@worktree")).toBe("agent-name@worktree");
  expect(VerifyInputShape.session_id!.parse("lane-xyz_1")).toBe("lane-xyz_1");
});
