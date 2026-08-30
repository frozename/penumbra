import { ValuePatternRedactor } from "@src/redaction/value-patterns.js";
import { expect, test } from "bun:test";

test("redactString rewrites matches and records hits", () => {
  const r = new ValuePatternRedactor([
    { id: "rmrf", pattern: /\brm\s+-rf\s+\/(?:\S+)?/g, replacement: "[REDACTED:rm-rf]" },
  ]);
  const { redacted, hits } = r.redactString("please run rm -rf /Volumes/WorkSSD now");
  expect(redacted).toBe("please run [REDACTED:rm-rf] now");
  expect(hits).toEqual([{ rule_id: "rmrf", count: 1 }]);
});

test("redactString is a no-op when no rule matches", () => {
  const r = new ValuePatternRedactor([
    { id: "rmrf", pattern: /\brm\s+-rf\s+\/(?:\S+)?/g, replacement: "[REDACTED:rm-rf]" },
  ]);
  const { redacted, hits } = r.redactString("hello world");
  expect(redacted).toBe("hello world");
  expect(hits).toEqual([]);
});

test("redactValue walks objects and arrays redacting string leaves", () => {
  const r = new ValuePatternRedactor([
    { id: "ssh", pattern: /\.ssh\/id_[a-z0-9]+/g, replacement: "[REDACTED:ssh-key]" },
  ]);
  const input = {
    cmd: "cat ~/.ssh/id_ed25519",
    nested: { args: ["--key", "~/.ssh/id_rsa"] },
    untouched: 42,
  };
  const { redacted, hits } = r.redactValue(input);
  expect(redacted.cmd).toBe("cat ~/[REDACTED:ssh-key]");
  expect(redacted.nested.args[1]).toBe("~/[REDACTED:ssh-key]");
  expect(redacted.untouched).toBe(42);
  expect(hits.find((h) => h.rule_id === "ssh")?.count).toBe(2);
});
