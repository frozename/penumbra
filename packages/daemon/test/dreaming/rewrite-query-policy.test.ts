import { expect, test } from "bun:test";

import { REWRITE_RESPONSE_SCHEMA } from "@src/dreaming/dream-rewriter-prompt-content.js";
import { validateRewriteQuery } from "@src/dreaming/rewrite-query-policy.js";

for (const query of [
  "SQLite WAL checkpoint reader contention",
  "TypeScript strict null checks async functions",
  "Node.js EventEmitter synchronous listener ordering",
]) {
  test(`accepts a public technical formulation: ${query}`, () => {
    expect(validateRewriteQuery(query)).toEqual({ ok: true });
  });
}

for (const query of [
  "SQLite WAL checkpoints https://private.internal/customer",
  "SQLite WAL alice@example.invalid debugging",
  "SQLite WAL 192.168.1.42 debugging",
  "SQLite errors /Users/example/private/cache analysis",
  "SQLite errors C:\\Users\\example\\private analysis",
  "SQLite failures password=synthetic-private-value analysis",
  "SQLite errors 9e8c2b62-9218-4b8c-a82f-8d0f058f2f7a analysis",
  "PrivateLeaseLedger queue retry timing behavior",
  "handoff queue retry timing behavior",
  "SQLite\nWAL checkpoint reader contention",
  "SQLite WAL \u202echeckpoint reader contention",
  '"SQLite WAL checkpoint reader contention"',
  "SQLite WAL checkpoint",
  "one two three four five six seven eight nine ten eleven twelve thirteen",
]) {
  test("blocks unsafe or out-of-contract text even when the optional heuristic is disabled", () => {
    expect(validateRewriteQuery(query, false).ok).toBe(false);
  });
}

test("rewrite schemas reject extra model-controlled fields", () => {
  expect(
    REWRITE_RESPONSE_SCHEMA.safeParse({
      kind: "query",
      query: "SQLite WAL checkpoint reader contention",
      public: true,
    }).success,
  ).toBe(false);
  expect(
    REWRITE_RESPONSE_SCHEMA.safeParse({
      kind: "skip",
      reason: "private",
      override: "search anyway",
    }).success,
  ).toBe(false);
});
