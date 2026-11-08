import { expect, test } from "bun:test";

import { verifyTdd } from "@src/gates/tdd.js";

test("treats a dispatch result without stdout as missing bun test output, not inert", () => {
  const r = verifyTdd({ dispatchResult: {} });
  expect(r.passed).toBe(false);
  expect(r.evidence).toBe("no `bun test` output found in dispatch stdout");
});

test("matches the bun test marker case-insensitively", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "BUN TEST v1.3.13\n4 pass\n0 fail\n" } });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("4 pass, 0 fail");
});

test("fails with no pass count detected when the output has a marker and 0 fail but no pass line", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "bun test v1.3.13\n0 fail\n" } });
  expect(r.passed).toBe(false);
  expect(r.evidence).toBe("no pass count detected");
});

test("reports the parsed pass count in evidence", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "bun test v1.3.13\n12 pass\n0 fail\n" } });
  expect(r.evidence).toBe("12 pass, 0 fail");
});

test("counts an upper-case FAIL line as failures", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "bun test v1.3.13\n7 pass\n2 FAIL\n" } });
  expect(r.passed).toBe(false);
  expect(r.evidence).toBe("2 fail in test output");
});

test("reports the inert evidence when no dispatch result is given", () => {
  const r = verifyTdd({});
  expect(r.evidence).toBe("no dispatch result; gate inert");
});
