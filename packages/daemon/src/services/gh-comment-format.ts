export type PenumbraCommentKind = "status_change" | "verdict" | "dispatch_failure" | "manual";

type StatusTransition = {
  from_status: string;
  to_status: string;
};

type ReviewVerdict = {
  passed: boolean;
  notes: string;
};

export type FormatPenumbraCommentInput = (
  | {
      task_id: string;
      kind: "status_change";
      ts: string;
      status_transition: StatusTransition;
    }
  | {
      task_id: string;
      kind: "verdict";
      ts: string;
      verdict: ReviewVerdict;
    }
  | {
      task_id: string;
      kind: "dispatch_failure";
      ts: string;
      reason: string;
    }
  | {
      task_id: string;
      kind: "manual";
      ts: string;
      body: string;
    }
) & { idempotency_key?: string };

const PENUMBRA_MARKER_PREFIX = "<!-- penumbra:source=task:";

function markerLine(
  task_id: string,
  kind: PenumbraCommentKind,
  ts: string,
  idempotency_key?: string,
): string {
  const ik = idempotency_key ? ` idempotency_key=${idempotency_key}` : "";
  return `${PENUMBRA_MARKER_PREFIX}${task_id} kind=${kind} ts=${ts}${ik} -->`;
}

function normalizeStatus(status: string): string {
  switch (status) {
    case "done":
      return "completed";
    case "done_pending_review":
      return "in_review";
    case "leased":
      return "in_progress";
    case "cancelled":
      return "canceled";
    default:
      return status;
  }
}

function renderBody(input: FormatPenumbraCommentInput): string {
  switch (input.kind) {
    case "status_change":
      return [
        `Penumbra task status changed.`,
        "",
        `Task: \`${input.task_id}\``,
        `Transition: \`${normalizeStatus(input.status_transition.from_status)}\` -> \`${normalizeStatus(input.status_transition.to_status)}\``,
      ].join("\n");
    case "verdict":
      return [
        `Penumbra review verdict posted.`,
        "",
        `Task: \`${input.task_id}\``,
        `Verdict: \`${input.verdict.passed ? "passed" : "failed"}\``,
        `Notes: ${input.verdict.notes}`,
      ].join("\n");
    case "dispatch_failure":
      return [
        `Penumbra dispatch failure recorded.`,
        "",
        `Task: \`${input.task_id}\``,
        `Reason: ${input.reason}`,
      ].join("\n");
    case "manual":
      return [
        `Penumbra manual note.`,
        "",
        `Task: \`${input.task_id}\``,
        "",
        input.body.trim(),
      ].join("\n");
  }
}

export function formatPenumbraComment(input: FormatPenumbraCommentInput): string {
  return `${markerLine(input.task_id, input.kind, input.ts, input.idempotency_key)}\n\n${renderBody(input)}`;
}

export function isPenumbraAuthoredComment(input: {
  body: string;
  author_login: string;
  expected_author_login: string | null;
}): boolean {
  if (!input.expected_author_login) return false;
  if (input.author_login !== input.expected_author_login) return false;
  return input.body.includes(PENUMBRA_MARKER_PREFIX);
}
