import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function collapsedDoc(): string {
  return readFileSync(
    new URL("../plugin/agents/penumbra-dispatcher.md", import.meta.url),
    "utf8",
  ).replaceAll(/\s+/g, " ");
}

test("a non-terminal chain is reported as still_running, never stalled", () => {
  const doc = collapsedDoc();
  expect(doc).toContain('status="still_running"');
  expect(doc).not.toContain("stalled");
});

test("chain_wait timeout is defined as non-terminal and only appears in prohibitions", () => {
  const doc = collapsedDoc();
  expect(doc).toContain("is NOT terminal");
  expect(doc).toContain("`completed`, `failed` or `rejected`");
  for (const sentence of doc.split(/(?<=[.!?])\s+/)) {
    if (sentence.includes('"timeout"')) {
      expect(sentence).toMatch(/never|not terminal/i);
    }
  }
});

test("still_running carries the ids and never cancels", () => {
  const doc = collapsedDoc();
  expect(doc).toContain("`still_running: conversation_id=<id> handoff_id=<id>`");
  expect(doc).toContain("do NOT call `chain_cancel`");
});

test("the salvage fallback sentence has no leftover fragment", () => {
  const doc = collapsedDoc();
  expect(doc).not.toContain("Only if inspection shows");
  expect(doc).toContain(
    "in `error_summary`. Otherwise (no branch, no commits, or a dirty tree) the chain is still running",
  );
});

test("the wait budget is used in full and its maximum is documented", () => {
  const doc = collapsedDoc();
  expect(doc).toContain("never stop early");
  expect(doc).toContain("100 minutes");
  expect(doc).toContain("only `spec.timeout_ms` sets `N`");
});
