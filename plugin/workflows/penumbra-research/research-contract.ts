import { z } from "zod";

import { renderJsonContract } from "../_shared/structured.js";

export const PlannerSchema = z
  .object({
    subquestions: z.array(z.string()).max(6),
  })
  .strict();

export const FindingSchema = z
  .object({
    subquestion: z.string().min(1).max(500),
    findings: z.string().min(1).max(8000),
    sources: z.array(z.string().min(1).max(2000)).min(2).max(12),
  })
  .strict();

export const SynthesisSchema = z
  .object({
    report: z.string().min(1).max(20000),
    summary: z.string().min(1).max(2000),
    sources: z.array(z.string().min(1).max(2000)).min(1).max(72),
  })
  .strict();

export type PlannerResult = z.infer<typeof PlannerSchema>;
export type FindingResult = z.infer<typeof FindingSchema>;
export type SynthesisResult = z.infer<typeof SynthesisSchema>;

const SUBQUESTION_MAX = 500;
const FINDINGS_EXCERPT_MAX = 400;
const SUMMARY_MAX = 2000;
const MIN_RESEARCH_SOURCES = 2;
const MAX_RESEARCH_SOURCES = 12;
const MIN_SYNTHESIS_SOURCES = 1;
const MAX_SYNTHESIS_SOURCES = 72;

type SourceValidation = { ok: true; urls: string[] } | { ok: false };

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}

function canonicalDnsHost(hostname: string): string {
  if (hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname;
  }
  let host = hostname;
  while (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host.toLowerCase();
}

export function validateSourceUrls(
  urls: unknown,
  options: { min: number; max: number; minDistinctHosts?: number },
): SourceValidation {
  if (!Array.isArray(urls) || urls.length < options.min || urls.length > options.max) {
    return { ok: false };
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  const hosts = new Set<string>();
  for (const raw of urls) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw !== raw.trim() ||
      hasControlCharacter(raw)
    ) {
      return { ok: false };
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false };
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return { ok: false };
    }
    const normalized = parsed.href;
    if (seen.has(normalized)) return { ok: false };
    seen.add(normalized);
    hosts.add(canonicalDnsHost(parsed.hostname));
    canonical.push(normalized);
  }
  if (hosts.size < (options.minDistinctHosts ?? 0)) return { ok: false };
  return { ok: true, urls: canonical };
}

export function validatePlannerSubquestions(qs: unknown, expected: number): string[] | null {
  if (!Array.isArray(qs) || qs.length !== expected) return null;
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const raw of qs) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > SUBQUESTION_MAX ||
      raw !== raw.trim()
    ) {
      return null;
    }
    const key = raw.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    validated.push(raw);
  }
  return validated;
}

export function isSubquestionMatch(returned: string, dispatched: string): boolean {
  return returned === dispatched;
}

export function boundExcerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

export function boundSummary(text: string): string {
  return boundExcerpt(text, SUMMARY_MAX);
}

export function findingsExcerpt(text: string): string {
  return boundExcerpt(text, FINDINGS_EXCERPT_MAX);
}

export const RESEARCH_SOURCE_BOUNDS = {
  min: MIN_RESEARCH_SOURCES,
  max: MAX_RESEARCH_SOURCES,
  minDistinctHosts: 2,
} as const;

export const SYNTHESIS_SOURCE_BOUNDS = {
  min: MIN_SYNTHESIS_SOURCES,
  max: MAX_SYNTHESIS_SOURCES,
} as const;

export function buildPlannerPrompt(
  question: string,
  angles: number,
  priorBrief: string | null,
): string {
  const prior =
    priorBrief && priorBrief.length > 0
      ? `\n## Prior knowledge (avoid re-researching)\n${priorBrief}\n`
      : "";
  const example = JSON.stringify({ subquestions: ["sub-question one", "sub-question two"] });
  return [
    `Break this research question into exactly ${String(angles)} independent sub-questions that together cover it.`,
    "Each sub-question must be nonempty, distinct, and answerable from independent sources. Do not duplicate facets.",
    `Question: ${question}`,
    prior,
    renderJsonContract({ name: "planner", example }),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

export function buildResearchPrompt(subquestion: string): string {
  const example = JSON.stringify({
    subquestion: "the sub-question you were asked",
    findings: "concise cross-checked findings",
    sources: ["https://independent-source-a.example", "https://independent-source-b.example"],
  });
  return [
    "Research this sub-question using WebSearch and WebFetch. Cross-check across at least two independent sources.",
    "Report concise findings with the source URLs you relied on. Every claim must be sourced.",
    `Sub-question: ${subquestion}`,
    renderJsonContract({ name: "research", example }),
  ].join("\n");
}

export function buildSynthesisPrompt(
  question: string,
  priorBrief: string | null,
  findings: { subquestion: string; findings: string; sources: string[] }[],
): string {
  const prior = priorBrief && priorBrief.length > 0 ? `\n## Prior knowledge\n${priorBrief}\n` : "";
  const findingsBlock = JSON.stringify(findings, null, 2);
  const example = JSON.stringify({
    report: "# Report\n\n...cited markdown...",
    summary: "one-paragraph summary",
    sources: ["https://only-urls-from-accepted-findings.example"],
  });
  return [
    "Synthesize a cited report answering the question from the prior-knowledge brief and per-sub-question findings.",
    "Attribute claims to their sources. The sources array must contain ONLY URLs that appear in the findings below.",
    `Question: ${question}`,
    prior,
    "## Findings",
    findingsBlock,
    renderJsonContract({ name: "synthesis", example }),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}
