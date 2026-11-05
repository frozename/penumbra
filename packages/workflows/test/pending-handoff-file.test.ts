import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  parsePendingHandoffSections,
  pendingHandoffPath,
  upsertPendingHandoffSection,
} from "@src/pending-handoff-file.js";

const D = new Date("2026-01-02T03:04:05.000Z");
const EPOCH = new Date(0);

function sha256Hex16(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

// ── pendingHandoffPath ──────────────────────────────────────────────

test("lowercase slug is used verbatim", () => {
  expect(pendingHandoffPath("/r", "a_b-1")).toBe(join("/r", "pending-handoff.a_b-1.md"));
  expect(pendingHandoffPath("/r", "9x")).toBe(join("/r", "pending-handoff.9x.md"));
});

test("uppercase id is hashed, not used verbatim", () => {
  const path = pendingHandoffPath("/r", "Alpha");
  const expected = join("/r", `pending-handoff.${sha256Hex16("Alpha")}.md`);
  expect(path).toBe(expected);
  // Ensure "Alpha" and "alpha" produce different paths
  expect(path).not.toBe(pendingHandoffPath("/r", "alpha"));
});

test("a leading hyphen is hashed", () => {
  expect(pendingHandoffPath("/r", "-alpha")).toBe(
    join("/r", `pending-handoff.${sha256Hex16("-alpha")}.md`),
  );
});

test("the function is deterministic", () => {
  const a = pendingHandoffPath("/r", "Alpha");
  const b = pendingHandoffPath("/r", "Alpha");
  expect(a).toBe(b);
});

// ── upsertPendingHandoffSection ──────────────────────────────────────

test("empty existing text returns the section with replaced false", () => {
  const result = upsertPendingHandoffSection("", { name: "s", body: "B", writtenAt: D });
  expect(result).toEqual({
    text: `<!-- penumbra:section s -->\n<!-- penumbra:written ${D.toISOString()} -->\nB\n<!-- /penumbra:section s -->\n`,
    replaced: false,
  });
});

test("existing text without trailing newline gets a separator", () => {
  const result = upsertPendingHandoffSection("pre", { name: "s", body: "B", writtenAt: D });
  expect(result.text).toBe(
    "pre\n" +
      `<!-- penumbra:section s -->\n<!-- penumbra:written ${D.toISOString()} -->\nB\n<!-- /penumbra:section s -->\n`,
  );
  expect(result.replaced).toBe(false);
});

test("existing text with trailing newline gets no extra blank line", () => {
  const result = upsertPendingHandoffSection("pre\n", { name: "s", body: "B", writtenAt: D });
  expect(result.text).toBe(
    "pre\n" +
      `<!-- penumbra:section s -->\n<!-- penumbra:written ${D.toISOString()} -->\nB\n<!-- /penumbra:section s -->\n`,
  );
  expect(result.replaced).toBe(false);
});

test("replace keeps surroundings and updates the stamp", () => {
  const existing =
    "top\n" +
    `<!-- penumbra:section aXb -->\n<!-- penumbra:written ${D.toISOString()} -->\nX\n<!-- /penumbra:section aXb -->\n` +
    "bottom\n";
  const result = upsertPendingHandoffSection(existing, {
    name: "aXb",
    body: "Z",
    writtenAt: EPOCH,
  });
  expect(result.replaced).toBe(true);
  expect(result.text).toBe(
    "top\n" +
      `<!-- penumbra:section aXb -->\n<!-- penumbra:written ${EPOCH.toISOString()} -->\nZ\n<!-- /penumbra:section aXb -->\n` +
      "bottom\n",
  );
});

test("a name with regex metacharacters only matches itself", () => {
  const sectionAxb = `<!-- penumbra:section aXb -->\n<!-- penumbra:written ${D.toISOString()} -->\nX\n<!-- /penumbra:section aXb -->\n`;
  const text = "head\n" + sectionAxb + "tail\n";
  const result = upsertPendingHandoffSection(text, { name: "a.b", body: "Y", writtenAt: D });
  expect(result.replaced).toBe(false);
  // The aXb section is unchanged
  expect(result.text).toContain(sectionAxb);
  // The new a.b section is appended
  expect(result.text).toContain("<!-- penumbra:section a.b -->");
  // Both heads appear exactly once
  const aXbCount = (result.text.match(/<!-- penumbra:section aXb -->/g) ?? []).length;
  const abCount = (result.text.match(/<!-- penumbra:section a\.b -->/g) ?? []).length;
  expect(aXbCount).toBe(1);
  expect(abCount).toBe(1);
});

// ── parsePendingHandoffSections ──────────────────────────────────────

test("mismatched close tag parses to []", () => {
  const text = "<!-- penumbra:section a -->\nbody\n<!-- /penumbra:section b -->\n";
  const sections = parsePendingHandoffSections(text);
  expect(sections).toEqual([]);
});

test("unparseable stamp gives writtenAt null and trims body", () => {
  const text =
    "<!-- penumbra:section s -->\n<!-- penumbra:written not-a-date -->\n  body  \n<!-- /penumbra:section s -->\n";
  const sections = parsePendingHandoffSections(text);
  expect(sections).toEqual([{ writtenAt: null, body: "body" }]);
});

test("a valid stamp found inside the section content is parsed", () => {
  const text =
    "head\n<!-- penumbra:section s -->\n<!-- penumbra:written 2026-01-02T03:04:05.000Z -->\nbody\n<!-- /penumbra:section s -->\n";
  const sections = parsePendingHandoffSections(text);
  expect(sections).toEqual([{ writtenAt: D, body: "body" }]);
});

test("round trip: two sections parse in write order", () => {
  const r1 = upsertPendingHandoffSection("", { name: "aXb", body: "X", writtenAt: D });
  const r2 = upsertPendingHandoffSection(r1.text, { name: "a.b", body: "Y", writtenAt: D });

  const sections = parsePendingHandoffSections(r2.text);
  expect(sections).toHaveLength(2);
  expect(sections[0]?.body).toBe("X");
  expect(sections[0]?.writtenAt?.toISOString()).toBe(D.toISOString());
  expect(sections[1]?.body).toBe("Y");
  expect(sections[1]?.writtenAt?.toISOString()).toBe(D.toISOString());
});
