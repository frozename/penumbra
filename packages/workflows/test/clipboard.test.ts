import { expect, test } from "bun:test";
import { emitClipboardOutput } from "../src/outputs/clipboard.js";

test("emitClipboardOutput kills a hung child and resolves with a timeout warning", async () => {
  const start = Date.now();
  const r = await emitClipboardOutput({
    body: "ignored",
    command: { cmd: "sleep", args: ["30"] },
    timeoutMs: 100,
  });
  const elapsed = Date.now() - start;
  expect(r.warnings).toEqual(["output clipboard: timed out"]);
  expect(elapsed).toBeLessThan(3000);
});

test("emitClipboardOutput success path: writes to a passthrough command without warnings", async () => {
  const r = await emitClipboardOutput({
    body: "hello",
    command: { cmd: "cat", args: [] },
    timeoutMs: 3000,
  });
  expect(r.warnings).toEqual([]);
});

test("emitClipboardOutput surfaces a non-zero exit code as a warning", async () => {
  const r = await emitClipboardOutput({
    body: "x",
    command: { cmd: "sh", args: ["-c", "cat >/dev/null; exit 7"] },
    timeoutMs: 3000,
  });
  expect(r.warnings).toEqual(["output clipboard: exit 7"]);
});

test("emitClipboardOutput surfaces a spawn error as a warning", async () => {
  const r = await emitClipboardOutput({
    body: "x",
    command: { cmd: "this-binary-does-not-exist-penumbra-test", args: [] },
    timeoutMs: 3000,
  });
  expect(r.warnings.length).toBe(1);
  expect(r.warnings[0]).toMatch(/^output clipboard: /);
});
