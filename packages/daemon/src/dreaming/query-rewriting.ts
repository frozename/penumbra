import { createHash } from "node:crypto";

export interface WebSearchableResult {
  ok: boolean;
  reason?: string;
}

export const INTERNAL_TERMS_SEED = [
  "handoff",
  "handoffs",
  "dispatch_land",
  "dispatch land",
  "t0",
  "t1",
  "t2",
  "t1_rollup",
  "t2_memory",
  "cycle_id",
  "rollup_id",
  "memory_id",
  "project_id",
  "conversation_id",
  "penumbra",
  "maestro",
  "dreaming cycle",
  "codex-acp",
  "gemini-acp",
  "claude-acp",
  "agentchat",
  "worker_id",
  "autocommit",
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "p6",
] as const;

const COMMIT_PREFIX_RE =
  /^(feat|fix|refactor|chore|docs|test|perf|style|build|ci|revert)(\([^)]*\))?:/i;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "as",
  "if",
  "it",
  "this",
  "that",
  "from",
  "into",
  "about",
  "or",
  "but",
  "so",
  "not",
  "no",
]);

function isCommitPrefix(title: string): boolean {
  return COMMIT_PREFIX_RE.test(title.trimStart());
}

function tokenizedWords(title: string): string[] {
  return title
    .split(/[^a-zA-Z0-9_\\.:-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isCodeIdentifier(title: string): boolean {
  const tokens = tokenizedWords(title);
  return tokens.some((token) => {
    const underscoreCount = (token.match(/_/g) ?? []).length;
    if (underscoreCount >= 2) return true;
    if (underscoreCount === 1 && token.length >= 10) return true;
    if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(token) && token.length >= 8) return true;
    if (token.includes("::") && token.length >= 4) return true;
    if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$/i.test(token)) return true;
    return false;
  });
}

function getInternalTerms(): string[] {
  const envTerms = process.env.PENUMBRA_DREAMING_INTERNAL_TERMS;
  if (envTerms === undefined || envTerms.trim() === "") {
    return [...INTERNAL_TERMS_SEED];
  }

  const overrideTerms = envTerms
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  return overrideTerms.length > 0 ? overrideTerms : [...INTERNAL_TERMS_SEED];
}

function hasInternalJargon(title: string): boolean {
  const normalizedTitle = title.toLowerCase();
  const terms = getInternalTerms();

  for (const term of terms) {
    if (term.includes(" ")) {
      if (normalizedTitle.includes(term)) return true;
      continue;
    }

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`);
    if (pattern.test(normalizedTitle)) return true;
  }

  return false;
}

function tooLongOrEmptyTokens(title: string): number {
  const words = tokenizedWords(title);
  return words.length;
}

function tooLong(title: string): boolean {
  return tooLongOrEmptyTokens(title) > 12;
}

export function hashTitle(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 12);
}

export function isWebSearchable(title: string): WebSearchableResult {
  if (!title || title.trim().length === 0) {
    return { ok: false, reason: "too_short" };
  }

  if (isCommitPrefix(title)) {
    return { ok: false, reason: "commit_prefix" };
  }

  if (isCodeIdentifier(title)) {
    return { ok: false, reason: "code_identifier" };
  }

  if (hasInternalJargon(title)) {
    return { ok: false, reason: "internal_jargon" };
  }

  if (tooLong(title)) {
    return { ok: false, reason: "too_long" };
  }

  const tokens = tokenizedWords(title);
  const meaningful = tokens
    .map((token) => token.toLowerCase())
    .filter((token) => !STOP_WORDS.has(token));
  if (meaningful.length < 4) {
    return { ok: false, reason: "too_short" };
  }

  return { ok: true };
}
