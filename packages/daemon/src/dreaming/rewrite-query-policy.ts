import { createHash } from "node:crypto";

import { FEW_SHOT_EXAMPLES, SYSTEM_PROMPT } from "./dream-rewriter-prompt-content.js";
import { isWebSearchable, type WebSearchableResult } from "./query-rewriting.js";
import { sanitizeTitleForQuery } from "./query-sanitize.js";

export const REWRITE_POLICY_VERSION = `public-search-v2:${createHash("sha256")
  .update(JSON.stringify([SYSTEM_PROMPT, FEW_SHOT_EXAMPLES]))
  .digest("hex")}`;

const SENSITIVE_VALUE =
  /(?:\b[a-z][a-z\d+.-]*:\/\/|\b(?:javascript|data|file):|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\/(?:[\w.-]+\/)+|[a-z]:\\|\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b)/i;

export function validateRewriteQuery(
  query: string,
  checkSearchability = true,
): WebSearchableResult {
  if (!sanitizeTitleForQuery(query) || /[\p{Cc}\p{Cf}]/u.test(query)) {
    return { ok: false, reason: "invalid_query" };
  }
  if (/["'`#*]/.test(query)) return { ok: false, reason: "query_format" };
  const words = query.trim().split(/\s+/);
  if (words.length < 4 || words.length > 12) return { ok: false, reason: "word_count" };
  if (SENSITIVE_VALUE.test(query)) return { ok: false, reason: "sensitive_value" };
  if (words.some((word) => /^[A-Z][a-z\d]+(?:[A-Z][a-z\d]+){2,}$/.test(word))) {
    return { ok: false, reason: "code_identifier" };
  }
  const searchable = isWebSearchable(query);
  if (
    !searchable.ok &&
    (checkSearchability ||
      ["commit_prefix", "code_identifier", "internal_jargon"].includes(searchable.reason ?? ""))
  ) {
    return searchable;
  }
  return { ok: true };
}
