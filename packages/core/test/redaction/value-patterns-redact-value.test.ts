/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and sqlite row mocks intentionally use loose shapes */
import { expect, test } from "bun:test";
import {
  MAX_WALKER_DEPTH,
  MAX_WALKER_STRING_BYTES,
  ValuePatternRedactor,
} from "../../src/redaction/value-patterns.js";

test("redactValue: non-plain object roots are preserved (Date/URL/Map/RegExp)", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);

  const date = new Date("2026-05-11T00:00:00.000Z");
  const url = new URL("https://example.com");
  const map = new Map<string, string>([["k", "banana"]]);
  const regex = /banana/g;

  expect(r.redactValue(date).redacted).toBe(date);
  expect(r.redactValue(url).redacted).toBe(url);
  expect(r.redactValue(map).redacted).toBe(map);
  expect(r.redactValue(regex).redacted).toBe(regex);
});

test("redactValue: recursion cap records synthetic hit and avoids deep traversal", () => {
  const r = new ValuePatternRedactor([
    { id: "soft_ssh", pattern: /\.ssh\/id_ed25519/g, replacement: "[REDACTED:ssh]" },
  ]);

  let deep: unknown = ".ssh/id_ed25519";
  for (let i = 0; i < MAX_WALKER_DEPTH + 1; i++) {
    deep = { a: deep };
  }

  const walked = r.redactValue(deep, { maxDepth: MAX_WALKER_DEPTH });
  expect(walked.hits.find((h) => h.rule_id === "walker_depth_exceeded")?.count).toBe(1);
  expect(walked.hits.find((h) => h.rule_id === "soft_ssh")).toBeUndefined();
});

test("redactValue: oversize string records synthetic hit and preserves original bytes", () => {
  const r = new ValuePatternRedactor([
    { id: "soft_ssh", pattern: /\.ssh\/id_ed25519/g, replacement: "[REDACTED:ssh]" },
  ]);

  const value = { msg: `${"x".repeat(100_000)} .ssh/id_ed25519` };
  const walked = r.redactValue(value, { maxStringBytes: MAX_WALKER_STRING_BYTES });

  expect(walked.hits.find((h) => h.rule_id === "walker_string_oversize")?.count).toBe(1);
  expect((walked.redacted as any).msg).not.toContain(".ssh/id_ed25519");
  expect(Buffer.byteLength((walked.redacted as any).msg, "utf8")).toBeLessThanOrEqual(
    MAX_WALKER_STRING_BYTES,
  );
});

test("redactValue: oversize string redacts secrets within the sampled prefix", () => {
  const r = new ValuePatternRedactor([{ id: "soft_token", pattern: /token/g, replacement: "#" }]);

  const value = `${"x".repeat(10_000)} token ${"y".repeat(60_000)}`;
  const walked = r.redactValue(value, { maxStringBytes: MAX_WALKER_STRING_BYTES });

  expect(walked.rewritten).toBe(true);
  expect(walked.redacted).not.toContain("token");
  expect(Buffer.byteLength(walked.redacted, "utf8")).toBeLessThanOrEqual(MAX_WALKER_STRING_BYTES);
});

test("redactValue: oversize string truncates secrets beyond the sampled prefix", () => {
  const r = new ValuePatternRedactor([{ id: "soft_token", pattern: /token/g, replacement: "#" }]);

  const value = `${"x".repeat(MAX_WALKER_STRING_BYTES + 1)}token`;
  const walked = r.redactValue(value, { maxStringBytes: MAX_WALKER_STRING_BYTES });

  expect(walked.redacted).not.toContain("token");
});

test("redactValue: rewrites string leaves across mixed arrays/objects", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);
  const input = { x: [{ y: { z: "banana" } }] };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({ x: [{ y: { z: "[REDACTED:soft]" } }] });
  expect(walked.hits.find((h) => h.rule_id === "soft")?.count).toBe(1);
});

test("redactValue: clean array keeps the original reference (no allocation)", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);
  const input = Array.from({ length: 100 }, (_, i) => `clean-${i}`);

  const walked = r.redactValue(input);
  expect(walked.hits).toEqual([]);
  expect(walked.redacted).toBe(input);
});

test("redactValue: scans object keys and records key hits", () => {
  const r = new ValuePatternRedactor([
    { id: "soft_ssh", pattern: /\.ssh\/id_ed25519/g, replacement: "[REDACTED:ssh]" },
  ]);
  const input = { ".ssh/id_ed25519": "<content>" };

  const walked = r.redactValue(input);
  expect(walked.hits.find((h) => h.rule_id === "soft_ssh")?.count).toBe(1);
  expect(walked.redacted).toEqual({ "[REDACTED:ssh]": "<content>" });
  expect(walked.redacted).not.toBe(input);
});

test("redactValue: rewrites key and preserves clean value", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);
  const input = { "banana-key": "safe-value" };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({ "[REDACTED:soft]-key": "safe-value" });
  expect(walked.hits.find((h) => h.rule_id === "soft")?.count).toBe(1);
});

test("redactValue: clean object keys + clean values keep original reference (no allocation)", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);
  const input = { alpha: "safe", beta: 42 };

  const walked = r.redactValue(input);
  expect(walked.hits).toEqual([]);
  expect(walked.redacted).toBe(input);
});

test("redactValue: clean keys + dirty value returns a new object", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);
  const input = { alpha: "banana", beta: "safe" };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({ alpha: "[REDACTED:soft]", beta: "safe" });
  expect(walked.redacted).not.toBe(input);
});

test("redactValue: mixed clean and rewritten keys returns a new object", () => {
  const r = new ValuePatternRedactor([
    { id: "soft", pattern: /banana/g, replacement: "[REDACTED:soft]" },
  ]);
  const input = { clean: "v1", "banana-key": "v2" };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({ clean: "v1", "[REDACTED:soft]-key": "v2" });
  expect(walked.redacted).not.toBe(input);
});

test("redactValue: nested object key hits are redacted recursively", () => {
  const r = new ValuePatternRedactor([
    { id: "soft_ssh", pattern: /\.ssh\/id_ed25519/g, replacement: "[REDACTED:ssh]" },
  ]);
  const input = { level1: { level2: { ".ssh/id_ed25519": "token" } } };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({
    level1: { level2: { "[REDACTED:ssh]": "token" } },
  });
  expect(walked.hits.find((h) => h.rule_id === "soft_ssh")?.count).toBe(1);
});

test("redactValue: benign key names do not trigger rules", () => {
  const r = new ValuePatternRedactor([
    { id: "soft_ssh", pattern: /\.ssh\/id_ed25519/g, replacement: "[REDACTED:ssh]" },
  ]);
  const input = { name: "safe" };

  const walked = r.redactValue(input);
  expect(walked.hits).toEqual([]);
  expect(walked.redacted).toBe(input);
});

test("redactValue: key collisions keep all entries and record walker_key_collision hit", () => {
  const r = new ValuePatternRedactor([
    {
      id: "soft_ssh",
      pattern: /\.ssh\/id_(?:rsa|ed25519)/g,
      replacement: "[REDACTED:ssh-key-path]",
    },
  ]);
  const input = { ".ssh/id_rsa": "a", ".ssh/id_ed25519": "b" };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({
    "[REDACTED:ssh-key-path]": "a",
    "[REDACTED:ssh-key-path]__1": "b",
  });
  expect(walked.hits.find((h) => h.rule_id === "walker_key_collision")?.count).toBe(1);
});
