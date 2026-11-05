import {
  DEFAULT_REDACTION_RULES,
  RegexRedactor,
  stripPrivacyTags,
  ValuePatternRedactor,
  type ValuePatternRule,
} from "@penumbra/core";
import { canonicalJson } from "@penumbra/core/evals/canonical";

import { MAESTRO_STATIC_RULES } from "@src/worker/maestro-output-rules.js";

export interface Sanitizer {
  sanitizeString(value: string): string;
  sanitizeValue<T>(value: T): T;
  remaps(): ReadonlyMap<string, string>;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const HOME_PATTERN = /\/Users\/[^/\s"'`]+/g;
const VOLUMES_PATTERN = /\/Volumes\/[^/\s"'`]+/g;
const PRIVATE_IPV4_PATTERN =
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g;
const PRIVATE_HOST_PATTERN =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:local|lan)\b/gi;

function emailReplacement(match: string): string {
  const domain = match.slice(match.indexOf("@") + 1).toLowerCase();
  return domain === "example.com" ? match : "user@example.com";
}

function remapToken(remap: Map<string, string>, original: string): string {
  const existing = remap.get(original);
  if (existing !== undefined) return existing;
  const token = `h-${String(remap.size + 1).padStart(3, "0")}`;
  remap.set(original, token);
  return token;
}

function remappingRule(id: string, pattern: RegExp, remap: Map<string, string>): ValuePatternRule {
  return {
    id,
    pattern,
    replacement: (match: string): string => remapToken(remap, match),
  };
}

function buildRules(remap: Map<string, string>): ValuePatternRule[] {
  return [
    ...MAESTRO_STATIC_RULES,
    { id: "email-domain", pattern: EMAIL_PATTERN, replacement: emailReplacement },
    { id: "home-path", pattern: HOME_PATTERN, replacement: "/home/user" },
    { id: "volume-mount", pattern: VOLUMES_PATTERN, replacement: "/mnt/volume" },
    remappingRule("private-ipv4", PRIVATE_IPV4_PATTERN, remap),
    remappingRule("private-host", PRIVATE_HOST_PATTERN, remap),
  ];
}

function sanitizeNode(value: unknown, sanitizeString: (text: string) => string): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeNode(entry, sanitizeString));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[sanitizeString(key)] = sanitizeNode(entry, sanitizeString);
    }
    return out;
  }
  return value;
}

export function createSanitizer(): Sanitizer {
  const remap = new Map<string, string>();
  const redactor = new ValuePatternRedactor(buildRules(remap));
  const sanitizeString = (text: string): string =>
    redactor.redactString(stripPrivacyTags(text)).redacted;
  return {
    sanitizeString,
    sanitizeValue<T>(value: T): T {
      const keyRedacted: unknown = new RegexRedactor(DEFAULT_REDACTION_RULES).redact(value);
      return sanitizeNode(keyRedacted, sanitizeString) as T;
    },
    remaps: () => remap,
  };
}

export function isSanitized(value: unknown): boolean {
  try {
    const before = canonicalJson(value);
    const after = canonicalJson(createSanitizer().sanitizeValue(value));
    return before === after;
  } catch {
    return false;
  }
}
