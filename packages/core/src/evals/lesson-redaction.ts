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

function buildRules(options?: LessonRedactionOptions): ValuePatternRule[] {
  const rules: ValuePatternRule[] = [];
  rules.push({ id: "home_path", pattern: HOME_PATH_PATTERN, replacement: "~" });
  const identifierPattern = buildIdentifierPattern(options?.production_identifiers ?? []);
  if (identifierPattern !== null) {
    rules.push({
      id: "production_identifier",
      pattern: identifierPattern,
      replacement: "[REDACTED:production_identifier]",
    });
  }
  rules.push({ id: "email", pattern: EMAIL_PATTERN, replacement: "[REDACTED:email]" });
  rules.push({ id: "ipv4", pattern: IPV4_PATTERN, replacement: "[REDACTED:ipv4]" });
  return rules;
}

function redactEmailsInIdentifiers(
  text: string,
  identifiers: readonly string[],
): { redacted: string; emailHitCount: number } {
  const matches = text.match(EMAIL_PATTERN);
  if (!matches || matches.length === 0) {
    return { redacted: text, emailHitCount: 0 };
  }
  const cleanedIdentifiers = identifiers.map((id) => id.trim()).filter((id) => id.length > 0);
  if (cleanedIdentifiers.length === 0) {
    return { redacted: text, emailHitCount: 0 };
  }
  let out = text;
  let emailHitCount = 0;
  for (const emailMatch of matches) {
    EMAIL_PATTERN.lastIndex = 0;
    for (const identifier of cleanedIdentifiers) {
      const lowerEmail = emailMatch.toLowerCase();
      const lowerId = identifier.toLowerCase();
      if (lowerEmail.includes(lowerId) && lowerEmail !== lowerId) {
        out = out.replace(emailMatch, "[REDACTED:email]");
        emailHitCount++;
        break;
      }
    }
  }
  return { redacted: out, emailHitCount };
}

function redactHomePathIdentifiers(
  text: string,
  identifiers: readonly string[],
): { redacted: string; homePathIdHitCount: number } {
  const cleanedIdentifiers = identifiers.map((id) => id.trim()).filter((id) => id.length > 0);
  if (cleanedIdentifiers.length === 0) {
    return { redacted: text, homePathIdHitCount: 0 };
  }
  let out = text;
  let homePathIdHitCount = 0;
  for (const identifier of cleanedIdentifiers) {
    HOME_PATH_PATTERN.lastIndex = 0;
    const homeMatch = identifier.match(HOME_PATH_PATTERN);
    if (homeMatch === null) {
      continue;
    }
    const segment = homeMatch[0];
    if (segment.toLowerCase() === identifier.toLowerCase().slice(0, segment.length)) {
      const replaced = replaceAndCountHomePathSegment(out, identifier, segment);
      if (replaced.count > 0) {
        out = replaced.text;
        homePathIdHitCount++;
      }
    }
  }
  return { redacted: out, homePathIdHitCount };
}

function replaceAndCountHomePathSegment(
  text: string,
  identifier: string,
  homeSegment: string,
): { text: string; count: number } {
  const identifierLower = identifier.toLowerCase();
  const textLower = text.toLowerCase();
  const idx = textLower.indexOf(homeSegment.toLowerCase());
  if (idx === -1) {
    return { text, count: 0 };
  }
  const endOfSegment = idx + homeSegment.length;
  let endOfIdentifier = text.length;
  for (let i = endOfSegment; i < text.length; i++) {
    if (identifierLower[i] === textLower[i]) {
      endOfIdentifier = i + 1;
    } else {
      break;
    }
  }
  if (endOfIdentifier <= endOfSegment) {
    return { text, count: 0 };
  }
  return {
    text: text.slice(0, idx) + "[REDACTED:production_identifier]" + text.slice(endOfIdentifier),
    count: 1,
  };
}

export function redactLessonDraft<T extends LessonTextFields>(
  draft: T,
  opts?: LessonRedactionOptions,
): { draft: T; redactions: LessonRedactionHit[] } {
  const identifiers = opts?.production_identifiers ?? [];
  const redactor = new ValuePatternRedactor(buildRules(opts));
  const hitCounts = new Map<string, number>();

  const redact = (text: string): string => {
    const emailPreRedacted = redactEmailsInIdentifiers(text, identifiers);
    const homePathPreRedacted = redactHomePathIdentifiers(emailPreRedacted.redacted, identifiers);
    const result = redactor.redactString(homePathPreRedacted.redacted);
    if (emailPreRedacted.emailHitCount > 0) {
      hitCounts.set("email", (hitCounts.get("email") ?? 0) + emailPreRedacted.emailHitCount);
    }
    if (homePathPreRedacted.homePathIdHitCount > 0) {
      hitCounts.set(
        "production_identifier",
        (hitCounts.get("production_identifier") ?? 0) + homePathPreRedacted.homePathIdHitCount,
      );
    }
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
