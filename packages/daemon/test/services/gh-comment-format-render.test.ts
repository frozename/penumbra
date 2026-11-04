import { expect, test } from "bun:test";

import {
  formatPenumbraComment,
  isPenumbraAuthoredComment,
} from "@src/services/gh-comment-format.js";

const TS = "2026-05-08T16:00:00.000Z";
const T1 = "t1";

// 1. Marker kind per comment kind
test("marker includes kind=status_change", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "pending", to_status: "done" },
  });
  const firstLine = body.split("\n")[0] ?? "";
  expect(firstLine).toBe(`<!-- penumbra:source=task:${T1} kind=status_change ts=${TS} -->`);
});

test("marker includes kind=verdict", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "verdict",
    ts: TS,
    verdict: { passed: true, notes: "" },
  });
  const firstLine = body.split("\n")[0] ?? "";
  expect(firstLine).toBe(`<!-- penumbra:source=task:${T1} kind=verdict ts=${TS} -->`);
});

test("marker includes kind=dispatch_failure", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "dispatch_failure",
    ts: TS,
    reason: "timeout",
  });
  const firstLine = body.split("\n")[0] ?? "";
  expect(firstLine).toBe(`<!-- penumbra:source=task:${T1} kind=dispatch_failure ts=${TS} -->`);
});

test("marker includes kind=manual", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "manual",
    ts: TS,
    body: "hello",
  });
  const firstLine = body.split("\n")[0] ?? "";
  expect(firstLine).toBe(`<!-- penumbra:source=task:${T1} kind=manual ts=${TS} -->`);
});

// 2. idempotency_key set
test("marker includes idempotency_key", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "manual",
    ts: TS,
    body: "hello",
    idempotency_key: "ik-1",
  });
  const firstLine = body.split("\n")[0] ?? "";
  expect(firstLine).toBe(
    `<!-- penumbra:source=task:${T1} kind=manual ts=${TS} idempotency_key=ik-1 -->`,
  );
});

// 3. Empty idempotency_key leaves no suffix
test("empty idempotency_key produces identical line to no key", () => {
  const withKey = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "pending", to_status: "done" },
    idempotency_key: "",
  });
  const withoutKey = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "pending", to_status: "done" },
  });
  const withFirst = withKey.split("\n")[0] ?? "";
  const withoutFirst = withoutKey.split("\n")[0] ?? "";
  expect(withFirst).toBe(withoutFirst);
});

// 4. Marker and body separated by exactly one blank line
test("marker and body separated by one blank line", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "pending", to_status: "done" },
  });
  const parts = body.split("\n");
  expect(parts[1] ?? "").toBe("");
  expect(parts[2] ?? "").toBe("Penumbra task status changed.");
});

// 5. Status normalisation mapping
test("status normalisation done->completed", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "done", to_status: "done" },
  });
  const lines = body.split("\n");
  const transitionLine = lines[5] ?? "";
  expect(transitionLine).toBe("Transition: `completed` -> `completed`");
});

test("status normalisation done_pending_review->in_review", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "done_pending_review", to_status: "done" },
  });
  const lines = body.split("\n");
  const transitionLine = lines[5] ?? "";
  expect(transitionLine).toBe("Transition: `in_review` -> `completed`");
});

test("status normalisation leased->in_progress", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "leased", to_status: "done" },
  });
  const lines = body.split("\n");
  const transitionLine = lines[5] ?? "";
  expect(transitionLine).toBe("Transition: `in_progress` -> `completed`");
});

test("status normalisation cancelled->canceled", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "cancelled", to_status: "done" },
  });
  const lines = body.split("\n");
  const transitionLine = lines[5] ?? "";
  expect(transitionLine).toBe("Transition: `canceled` -> `completed`");
});

// 6. Unknown statuses pass through; normalisation applies to from_status too
test("unknown statuses pass through unchanged", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "done", to_status: "blocked" },
  });
  const lines = body.split("\n");
  const transitionLine = lines[5] ?? "";
  expect(transitionLine).toBe("Transition: `completed` -> `blocked`");
});

// 7. Full status_change body
test("full status_change body", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "status_change",
    ts: TS,
    status_transition: { from_status: "pending", to_status: "leased" },
  });
  const textAfterMarker = body.slice(body.indexOf("\n\n") + 2);
  expect(textAfterMarker).toBe(
    "Penumbra task status changed.\n\nTask: `t1`\nTransition: `pending` -> `in_progress`",
  );
});

// 8. verdict passed=true gives "passed" line, notes appear verbatim
test("verdict passed=true includes notes", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "verdict",
    ts: TS,
    verdict: { passed: true, notes: "all checks green" },
  });
  expect(body).toContain("Verdict: `passed`");
  expect(body).toContain("Notes: all checks green");
});

// 9. verdict passed=false gives "failed" line
test("verdict passed=false", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "verdict",
    ts: TS,
    verdict: { passed: false, notes: "some notes" },
  });
  expect(body).toContain("Verdict: `failed`");
});

// 10. dispatch_failure body
test("dispatch_failure body", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "dispatch_failure",
    ts: TS,
    reason: "timeout",
  });
  const textAfterMarker = body.slice(body.indexOf("\n\n") + 2);
  expect(textAfterMarker).toBe(
    "Penumbra dispatch failure recorded.\n\nTask: `t1`\nReason: timeout",
  );
});

// 11. manual body is trimmed
test("manual body is trimmed", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "manual",
    ts: TS,
    body: "  \n hello world \n\n",
  });
  const textAfterMarker = body.slice(body.indexOf("\n\n") + 2);
  expect(textAfterMarker).toBe("Penumbra manual note.\n\nTask: `t1`\n\nhello world");
});

// 12. isPenumbraAuthoredComment returns false when body has no marker
test("isPenumbraAuthoredComment false when no marker", () => {
  expect(
    isPenumbraAuthoredComment({
      body: "hello",
      author_login: "penumbra-bot",
      expected_author_login: "penumbra-bot",
    }),
  ).toBe(false);
});

// 13. isPenumbraAuthoredComment returns false when expected_author_login is empty string
test("isPenumbraAuthoredComment false when expected_author_login is empty string", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "manual",
    ts: TS,
    body: "hello",
  });
  expect(
    isPenumbraAuthoredComment({
      body,
      author_login: "",
      expected_author_login: "",
    }),
  ).toBe(false);
});

// 14. Marker can appear after other text (includes check)
test("marker appears after other text", () => {
  const rendered = formatPenumbraComment({
    task_id: T1,
    kind: "manual",
    ts: TS,
    body: "hello",
  });
  const body = "prefix text\n" + rendered;
  expect(
    isPenumbraAuthoredComment({
      body,
      author_login: "penumbra-bot",
      expected_author_login: "penumbra-bot",
    }),
  ).toBe(true);
});

// 15. Case-sensitive login comparison
test("login comparison is case-sensitive", () => {
  const body = formatPenumbraComment({
    task_id: T1,
    kind: "manual",
    ts: TS,
    body: "hello",
  });
  expect(
    isPenumbraAuthoredComment({
      body,
      author_login: "Penumbra-Bot",
      expected_author_login: "penumbra-bot",
    }),
  ).toBe(false);
});
