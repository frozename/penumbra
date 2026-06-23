export interface ContentQualityVerdict {
  score: number; // 0-1
  reasons: string[]; // ["relevance:0.62", "depth:0.5", "spam:0.85", "domain:trusted"]
  lowQuality: boolean; // score < threshold
}

export interface ContentQualityJudgeConfig {
  threshold: number;
  trustedDomains?: string[];
}

const DEFAULT_TRUSTED_DOMAINS = [
  "github.com",
  "bun.sh",
  "npmjs.com",
  "nodejs.org",
  "deno.land",
  "en.wikipedia.org",
  "docs.anthropic.com",
  "modelcontextprotocol.io",
  "sqlite.org",
];

function clamp01(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeQueryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.trim().length > 0),
    ),
  );
}

function countMarkdownLinks(markdown: string): number {
  const markdownLinks = markdown.match(/\[[^\]]+\]\([^)]+\)/g)?.length ?? 0;
  const bareUrls = markdown.match(/https?:\/\/[^\s\])]+/g)?.length ?? 0;
  return markdownLinks + bareUrls;
}

function isParentOrSelfMatch(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export class ContentQualityJudge {
  private readonly trustedDomains: string[];

  constructor(private readonly cfg: ContentQualityJudgeConfig) {
    this.trustedDomains = cfg.trustedDomains ?? DEFAULT_TRUSTED_DOMAINS;
  }

  judge(
    result: { url: string; title: string; markdown: string },
    query: string,
  ): Promise<ContentQualityVerdict> {
    const queryTerms = normalizeQueryTerms(query);
    const haystack = `${result.title} ${result.markdown.slice(0, 500)}`.toLowerCase();

    const matchedTerms = queryTerms.filter((term) => haystack.includes(term)).length;
    const relevance = queryTerms.length > 0 ? clamp01(matchedTerms / queryTerms.length) : 0;
    const depth = clamp01(result.markdown.length / 400);
    const wordCount = result.markdown
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
    const linkCount = countMarkdownLinks(result.markdown);
    const spamRatio = linkCount / Math.max(wordCount / 10, 1);
    const spamInverse = clamp01(1 - spamRatio);

    const hostname = extractHostname(result.url)?.toLowerCase() ?? "";
    const isTrustedDomain =
      hostname !== "" &&
      this.trustedDomains.some((domain) => isParentOrSelfMatch(hostname, domain));
    const domainBonus = isTrustedDomain ? 1 : 0;

    const score = clamp01(0.45 * relevance + 0.25 * depth + 0.2 * spamInverse + 0.1 * domainBonus);

    const reasons = [
      `relevance:${relevance.toFixed(2)}`,
      `depth:${depth.toFixed(2)}`,
      `spam:${spamInverse.toFixed(2)}`,
      `domain:${isTrustedDomain ? "trusted" : "untrusted"}`,
    ];

    return Promise.resolve({
      score,
      reasons,
      lowQuality: score < this.cfg.threshold,
    });
  }
}
