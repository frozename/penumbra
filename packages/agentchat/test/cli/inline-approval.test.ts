import { parseApprovalKey } from "@src/cli/inline-approval.js";
import { expect, test } from "bun:test";

test("y/yes/n/no/s/skip parse correctly", () => {
  expect(parseApprovalKey("y")).toEqual({ kind: "yes" });
  expect(parseApprovalKey("yes")).toEqual({ kind: "yes" });
  expect(parseApprovalKey("n")).toEqual({ kind: "no" });
  expect(parseApprovalKey("s")).toEqual({ kind: "skip" });
});
test("redirect parses target", () => {
  expect(parseApprovalKey("r codex")).toEqual({ kind: "redirect", target: "codex" });
  expect(parseApprovalKey("redirect codex")).toEqual({ kind: "redirect", target: "codex" });
});
test("garbage returns null", () => {
  expect(parseApprovalKey("xyz")).toBeNull();
});
