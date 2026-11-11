import { z } from "zod";

import {
  type RedactStringResult,
  ValuePatternRedactor,
  type ValueRedactionHit,
} from "../redaction/value-patterns.js";

export const LessonRedactionOptionsSchema = z.strictObject({
  production_identifiers: z.array(z.string()).optional(),
});

export type LessonRedactionOptions = z.infer<typeof LessonRedactionOptionsSchema>;

export type LessonRedactionHit = {
  rule_id: string;
  count: number;
};

export type LessonTextFields = {
  failure_signature: string;
  root_cause: string;
  procedure: string[];
  applicability: string[];
  exclusions: string[];
  counterexample: string | null;
};

const REGEX_SYNTAX_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

// Mirrors HOME_GENERIC_REDACTION_RULE in packages/core/src/dispatch/capsule/preflight.ts until a shared core rule set exists.
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s]+/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(
  `\\b${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\b`,
  "g",
);

type LessonRule = {
  id: string;
  pattern: RegExp;
  replacement: string;
};

type CandidateSpan = {
  rule: LessonRule;
  ruleIndex: number;
  start: number;
  end: number;
};

function compareByIdentifierLength(a: string, b: string): number {
  if (b.length !== a.length) {
    return b.length - a.length;
  }
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function buildIdentifierPattern(identifiers: readonly string[]): RegExp | null {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of identifiers) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  if (cleaned.length === 0) {
    return null;
  }
  const alternation = cleaned
    .toSorted(compareByIdentifierLength)
    .map((identifier) => identifier.replaceAll(REGEX_SYNTAX_CHARACTERS, "\\$&"))
    .join("|");
  return new RegExp(alternation, "gi");
}

function buildRules(options?: LessonRedactionOptions): LessonRule[] {
  const rules: LessonRule[] = [
    { id: "email", pattern: EMAIL_PATTERN, replacement: "[REDACTED:email]" },
  ];
  const identifierPattern = buildIdentifierPattern(options?.production_identifiers ?? []);
  if (identifierPattern !== null) {
    rules.push({
      id: "production_identifier",
      pattern: identifierPattern,
      replacement: "[REDACTED:production_identifier]",
    });
  }
  rules.push({ id: "home_path", pattern: HOME_PATH_PATTERN, replacement: "~" });
  rules.push({ id: "ipv4", pattern: IPV4_PATTERN, replacement: "[REDACTED:ipv4]" });
  return rules;
}

function collectCandidateSpans(text: string, rules: readonly LessonRule[]): CandidateSpan[] {
  const candidates: CandidateSpan[] = [];
  for (const [ruleIndex, rule] of rules.entries()) {
    for (const match of text.matchAll(rule.pattern)) {
      candidates.push({ rule, ruleIndex, start: match.index, end: match.index + match[0].length });
    }
  }
  return candidates;
}

function compareCandidates(a: CandidateSpan, b: CandidateSpan): number {
  if (a.start !== b.start) {
    return a.start - b.start;
  }
  const lengthDelta = b.end - b.start - (a.end - a.start);
  if (lengthDelta !== 0) {
    return lengthDelta;
  }
  return a.ruleIndex - b.ruleIndex;
}

// Leftmost-first, longest candidate wins each position: span length, never
// rule order, decides whether a listed identifier or a built-in is applied.
function selectSpans(candidates: readonly CandidateSpan[]): CandidateSpan[] {
  const selected: CandidateSpan[] = [];
  let cursor = 0;
  for (const candidate of candidates.toSorted(compareCandidates)) {
    if (candidate.start < cursor) {
      continue;
    }
    selected.push(candidate);
    cursor = candidate.end;
  }
  return selected;
}

function buildRedacted(text: string, selected: readonly CandidateSpan[]): string {
  let out = "";
  let previousEnd = 0;
  for (const span of selected) {
    out += text.slice(previousEnd, span.start);
    out += span.rule.replacement;
    previousEnd = span.end;
  }
  return out + text.slice(previousEnd);
}

function countSelectedSpans(selected: readonly CandidateSpan[]): ValueRedactionHit[] {
  const counts = new Map<string, number>();
  for (const span of selected) {
    counts.set(span.rule.id, (counts.get(span.rule.id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([rule_id, count]) => ({ rule_id, count }));
}

// Sequential per-rule passes (the base ValuePatternRedactor walk) let a
// built-in claim the start of a longer listed identifier; this merges every
// rule's matches and keeps the longest span at each position instead.
class LongestMatchRedactor extends ValuePatternRedactor {
  constructor(private readonly lessonRules: readonly LessonRule[]) {
    super(lessonRules);
  }

  public override redactString(text: string): RedactStringResult {
    const selected = selectSpans(collectCandidateSpans(text, this.lessonRules));
    return { redacted: buildRedacted(text, selected), hits: countSelectedSpans(selected) };
  }
}

export function redactLessonDraft<T extends LessonTextFields>(
  draft: T,
  opts?: LessonRedactionOptions,
): { draft: T; redactions: LessonRedactionHit[] } {
  const redactor = new LongestMatchRedactor(buildRules(opts));
  const hitCounts = new Map<string, number>();

  const redact = (text: string): string => {
    const result = redactor.redactString(text);
    for (const hit of result.hits) {
      hitCounts.set(hit.rule_id, (hitCounts.get(hit.rule_id) ?? 0) + hit.count);
    }
    return result.redacted;
  };

  const redactedDraft = {
    ...draft,
    failure_signature: redact(draft.failure_signature),
    root_cause: redact(draft.root_cause),
    procedure: draft.procedure.map((step) => redact(step)),
    applicability: draft.applicability.map((entry) => redact(entry)),
    exclusions: draft.exclusions.map((entry) => redact(entry)),
    counterexample: draft.counterexample === null ? null : redact(draft.counterexample),
  };

  const redactions = [...hitCounts.entries()]
    .filter((entry) => entry[1] > 0)
    .map(([rule_id, count]) => ({ rule_id, count }))
    .toSorted((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));

  return { draft: redactedDraft, redactions };
}
