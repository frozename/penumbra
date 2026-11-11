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
const IPV4_PATTERN = new RegExp(
  `\\b${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\b`,
  "g",
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

// When a listed identifier was an email's local part, production_identifier
// replaces just that local part and the email rule can no longer match, leaving
// '[REDACTED:production_identifier]@<domain>' with the domain in clear text.
// This post-pass collapses the placeholder plus the leftover domain fragment
// into a single email placeholder. It is monotone: it only ever turns clear text
// into a placeholder, never the reverse.
//
// Three shapes are handled:
//   1) Local-part suffix: the identifier appears as a suffix inside the email's
//      local part (e.g. 'bob-[REDACTED:production_identifier]@corp.io').
//      The pattern absorbs a run of up to 64 email local-part characters directly
//      before the placeholder: /[A-Za-z0-9._%+-]{0,64}\[REDACTED:production_identifier\]@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
//      The leading run is bounded ({0,64} here, {1,64} for the bare local part in
//      the domain pattern) so the regexes stay linear: an unbounded run before a
//      required literal rescans the whole run from every start position, which is
//      quadratic on a long token with no '@'. 64 is the RFC 5321 local-part limit.
//      A local part longer than 64 characters still leaks its leading characters
//      (only the last 64 are absorbed), which is still monotone versus not
//      collapsing at all.
//      The character class excludes ']' and ':', so the run can never reach into
//      a preceding placeholder.
//   2) Whole domain: the identifier is the entire domain
//      (e.g. 'user@[REDACTED:production_identifier]'). The negative lookahead
//      stops the collapse when the placeholder is only part of the domain
//      (for example followed by '.com' or '-2').
//      A sentence-final '.' still collapses.
//   3) Bare 'user@<placeholder>' with no visible TLD also collapses, which is
//      acceptable because it is strictly more redacted. A placeholder local part
//      ('<placeholder>@<placeholder>') is covered by the first alternative of the
//      domain pattern.

const LEFTOVER_IDENTIFIER_EMAIL =
  /[A-Za-z0-9._%+-]{0,64}\[REDACTED:production_identifier\]@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const LEFTOVER_IDENTIFIER_DOMAIN =
  /(?:[A-Za-z0-9._%+-]{0,64}\[REDACTED:production_identifier\][A-Za-z0-9._%+-]*|[A-Za-z0-9._%+-]{1,64})@\[REDACTED:production_identifier\](?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;

function collapseIdentifierEmailPlaceholder(text: string): { redacted: string; count: number } {
  if (!text.includes("[REDACTED:production_identifier]")) {
    return { redacted: text, count: 0 };
  }
  let count = 0;
  const step1 = text.replaceAll(LEFTOVER_IDENTIFIER_EMAIL, () => {
    count++;
    return "[REDACTED:email]";
  });
  const step2 = step1.replaceAll(LEFTOVER_IDENTIFIER_DOMAIN, () => {
    count++;
    return "[REDACTED:email]";
  });
  return { redacted: step2, count };
}

function buildRules(options?: LessonRedactionOptions): ValuePatternRule[] {
  const rules: ValuePatternRule[] = [];
  const identifierPattern = buildIdentifierPattern(options?.production_identifiers ?? []);
  if (identifierPattern !== null) {
    rules.push({
      id: "production_identifier",
      pattern: identifierPattern,
      replacement: "[REDACTED:production_identifier]",
    });
  }
  rules.push({ id: "home_path", pattern: HOME_PATH_PATTERN, replacement: "~" });
  rules.push({ id: "email", pattern: EMAIL_PATTERN, replacement: "[REDACTED:email]" });
  rules.push({ id: "ipv4", pattern: IPV4_PATTERN, replacement: "[REDACTED:ipv4]" });
  return rules;
}

export function redactLessonDraft<T extends LessonTextFields>(
  draft: T,
  opts?: LessonRedactionOptions,
): { draft: T; redactions: LessonRedactionHit[] } {
  const redactor = new ValuePatternRedactor(buildRules(opts));
  const hitCounts = new Map<string, number>();

  const redact = (text: string): string => {
    const result = redactor.redactString(text);
    for (const hit of result.hits) {
      hitCounts.set(hit.rule_id, (hitCounts.get(hit.rule_id) ?? 0) + hit.count);
    }
    const collapsed = collapseIdentifierEmailPlaceholder(result.redacted);
    if (collapsed.count > 0) {
      hitCounts.set("email", (hitCounts.get("email") ?? 0) + collapsed.count);
    }
    return collapsed.redacted;
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
