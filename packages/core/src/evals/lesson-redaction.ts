import { z } from "zod";

import { ValuePatternRedactor, type ValuePatternRule } from "../redaction/value-patterns.js";

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
const IPV4_SOURCE = `\\b${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\b`;

const PLACEHOLDER_SOURCE = "\\[REDACTED:[a-z0-9_]+\\]";
const VERSION_DOT_MASK = "\u0000";

// Four-part versions ("v1.2.3.4", "version=1.2.3.4") are not addresses: their
// dots are masked before matching so the ipv4 branch cannot claim them.
// Single-digit parts keep real addresses (10.x, 192.168.x) redactable.
const LESSON_VERSION_PATTERN = new RegExp(
  "(?<![\\w-])(?:version|v)[:=]? ?(?<![\\d.])\\d\\.\\d\\.\\d\\.\\d(?![\\d.])",
  "gi",
);

function compareByIdentifierLength(a: string, b: string): number {
  if (b.length !== a.length) {
    return b.length - a.length;
  }
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function buildIdentifierAlternation(identifiers: readonly string[]): string | null {
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
  return cleaned
    .toSorted(compareByIdentifierLength)
    .map((identifier) => identifier.replaceAll(REGEX_SYNTAX_CHARACTERS, "\\$&"))
    .join("|");
}

function buildCombinedPattern(options?: LessonRedactionOptions): RegExp {
  const identifiers = buildIdentifierAlternation(options?.production_identifiers ?? []);
  return new RegExp(
    `(?<redacted_placeholder>${PLACEHOLDER_SOURCE})` +
      `|(?<email>${EMAIL_PATTERN.source})` +
      `|(?<production_identifier>${identifiers ?? "[^\\s\\S]"})` +
      `|(?<home_path>${HOME_PATH_PATTERN.source})` +
      `|(?<ipv4>${IPV4_SOURCE})`,
    "gi",
  );
}

function buildRules(options?: LessonRedactionOptions): {
  rules: ValuePatternRule[];
  pattern: RegExp;
} {
  const pattern = buildCombinedPattern(options);
  return {
    pattern,
    rules: [
      {
        id: "lesson_text",
        pattern,
        replacement: (match: string, ...groups: string[]): string => {
          if (groups[1] !== undefined) {
            return "[REDACTED:email]";
          }
          if (groups[2] !== undefined) {
            return "[REDACTED:production_identifier]";
          }
          if (groups[3] !== undefined) {
            return "~";
          }
          if (groups[4] !== undefined) {
            return "[REDACTED:ipv4]";
          }
          return match;
        },
      },
    ],
  };
}

type RedactionSpan = { rule_id: string; start: number; end: number };

function ruleIdForGroups(groups: Record<string, string> | undefined): string | undefined {
  if (groups === undefined) {
    return undefined;
  }
  if (groups.email !== undefined) {
    return "email";
  }
  if (groups.production_identifier !== undefined) {
    return "production_identifier";
  }
  if (groups.home_path !== undefined) {
    return "home_path";
  }
  if (groups.ipv4 !== undefined) {
    return "ipv4";
  }
  return undefined;
}

// Matches that touch only through "/" form one sensitive span (a path); the
// longest match in the span wins the hit attribution while every match still
// applies its own replacement.
function collectRedactionHits(text: string, pattern: RegExp): LessonRedactionHit[] {
  const spans: RedactionSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const rule_id = ruleIdForGroups(match.groups);
    if (rule_id === undefined) {
      continue;
    }
    spans.push({ rule_id, start: match.index, end: match.index + match[0].length });
  }

  const counts = new Map<string, number>();
  let region: RedactionSpan[] = [];
  let regionPreviousEnd = 0;
  const flushRegion = (): void => {
    if (region.length === 0) {
      return;
    }
    const winner = region.reduce((best, span) => {
      const bestLength = best.end - best.start;
      const length = span.end - span.start;
      return length > bestLength || (length === bestLength && span.start < best.start)
        ? span
        : best;
    });
    const winnerCount = region.filter((span) => span.rule_id === winner.rule_id).length;
    counts.set(winner.rule_id, (counts.get(winner.rule_id) ?? 0) + winnerCount);
    region = [];
  };
  for (const span of spans) {
    if (region.length > 0 && !/^\/+$/.test(text.slice(regionPreviousEnd, span.start))) {
      flushRegion();
    }
    region.push(span);
    regionPreviousEnd = span.end;
  }
  flushRegion();

  return [...counts.entries()].map(([rule_id, count]) => ({ rule_id, count }));
}

export function redactLessonDraft<T extends LessonTextFields>(
  draft: T,
  opts?: LessonRedactionOptions,
): { draft: T; redactions: LessonRedactionHit[] } {
  const { rules, pattern } = buildRules(opts);
  const redactor = new ValuePatternRedactor(rules);
  const hitCounts = new Map<string, number>();

  const redact = (input: string): string => {
    const text = input.replaceAll(LESSON_VERSION_PATTERN, (match) =>
      match.replaceAll(".", VERSION_DOT_MASK),
    );
    const result = redactor.redactString(text);
    for (const hit of collectRedactionHits(text, pattern)) {
      hitCounts.set(hit.rule_id, (hitCounts.get(hit.rule_id) ?? 0) + hit.count);
    }
    return result.redacted.replaceAll(VERSION_DOT_MASK, ".");
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
