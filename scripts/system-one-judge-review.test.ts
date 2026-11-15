import { expect, test } from "bun:test";

import {
  buildReviewPacket,
  type CompletedReview,
  mergeReviewPackets,
  type ReviewSource,
} from "./system-one-judge-review.js";

const source = (id: string, body: string, promoted = false): ReviewSource => ({
  rollup_id: id,
  session_id: id,
  project_id: "private-project",
  started_at: "2026-11-01T00:00:00Z",
  first_prompt_excerpt: body,
  t2_promoted_at: promoted ? "2026-11-02" : null,
});

test("review packets are deterministic, blinded and unlabelled", () => {
  const rows = [source("a", "Durable convention a"), source("b", "Session status b", true)];
  const a = buildReviewPacket(rows, { seed: "frozen", limit: 2, excludedHashes: [] });
  expect(a).toEqual(
    buildReviewPacket([...rows].reverse(), { seed: "frozen", limit: 2, excludedHashes: [] }),
  );
  expect(a.cases).toHaveLength(2);
  expect(a.cases[0]?.promote).toBeNull();
  const blind = JSON.stringify(a.cases);
  expect(blind).not.toContain("private-project");
  expect(blind).not.toContain("promoted_at");
  expect(blind).not.toContain("incumbent");
  expect(a.manifest.labelStatus).toBe("awaiting-independent-review");
});

test("pilot hashes, duplicate bodies and source families cannot inflate the fresh set", () => {
  const rows = [
    source("a", "old"),
    source("b", "duplicate"),
    source("c", "duplicate"),
    { ...source("d", "same session"), session_id: "b" },
  ];
  const result = buildReviewPacket(rows, {
    seed: "frozen",
    limit: 10,
    excludedHashes: [new Bun.CryptoHasher("sha256").update("old").digest("hex")],
  });
  expect(result.cases).toHaveLength(1);
  expect(result.key).toHaveLength(1);
});

test("sampling covers time, length and retention strata before filling a large bucket", () => {
  const rows = Array.from({ length: 20 }, (_, i) => source(String(i), `short ${String(i)}`));
  rows.push(source("long", "long ".repeat(2000), true));
  rows.push({ ...source("old", "other month"), started_at: "2026-09-01" });
  const result = buildReviewPacket(rows, { seed: "frozen", limit: 3, excludedHashes: [] });
  expect(result.manifest.strata).toHaveLength(3);
  expect(result.cases).toHaveLength(3);
});

const reviewed = (reviewer: string, promote: boolean | null): CompletedReview => ({
  caseId: "id",
  body: "visible input",
  promote,
  rationale: "specific reason",
  factualSupport: "insufficient",
  evidence: [],
  reviewer,
});

test("review merge preserves uncertainty and requires independent identities", () => {
  const packet = [{ caseId: "id", body: "visible input" }];
  expect(
    mergeReviewPackets(packet, [reviewed("a", null)], [reviewed("b", null)])[0]?.promote,
  ).toBeNull();
  expect(() =>
    mergeReviewPackets(packet, [reviewed("a", false)], [reviewed("a", false)]),
  ).toThrow();
  expect(() =>
    mergeReviewPackets(
      packet,
      [reviewed("a", false)],
      [{ ...reviewed("b", false), body: "changed" }],
    ),
  ).toThrow();
});

test("disagreements require explicit distinct adjudication and never become implicit negatives", () => {
  const packet = [{ caseId: "id", body: "visible input" }];
  expect(() => mergeReviewPackets(packet, [reviewed("a", true)], [reviewed("b", false)])).toThrow();
  expect(() =>
    mergeReviewPackets(
      packet,
      [reviewed("a", true)],
      [reviewed("b", false)],
      [reviewed("a", false)],
    ),
  ).toThrow();
  const merged = mergeReviewPackets(
    packet,
    [reviewed("a", true)],
    [reviewed("b", false)],
    [reviewed("c", null)],
  );
  expect(merged[0]).toMatchObject({
    promote: null,
    reviewProvenance: {
      reviewers: ["a", "b"],
      adjudicator: "c",
      method: "blind-source-checks",
      commonBaseModel: true,
    },
  });
});

test("each verified review must carry its own source evidence", () => {
  expect(() =>
    mergeReviewPackets(
      [{ caseId: "id", body: "visible input" }],
      [{ ...reviewed("a", true), factualSupport: "verified" }],
      [
        {
          ...reviewed("b", true),
          factualSupport: "verified",
          evidence: ["packages/core/src/db/schema.ts:122"],
        },
      ],
    ),
  ).toThrow();
});
