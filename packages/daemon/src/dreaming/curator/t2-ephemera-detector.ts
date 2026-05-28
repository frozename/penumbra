import { EPHEMERA_PROMPT_LIKE_PATTERNS } from "../cycle.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\//;

export function likeToRegex(pattern: string): RegExp {
  const s = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(s, "i");
}

export function detectT2Ephemera(
  mem: { title: string; body: string; kind: string },
  runtimePatterns: string[] = [],
): { isEphemera: boolean; reason?: string; confidence?: number } {
  const bodyTrimmed = mem.body.trim();

  if (UUID_RE.test(bodyTrimmed)) {
    return { isEphemera: true, reason: "uuid_body", confidence: 0.99 };
  }

  if (URL_RE.test(mem.title)) {
    return { isEphemera: true, reason: "url_title", confidence: 0.99 };
  }

  if (mem.kind === "brief" && bodyTrimmed.length < 30) {
    return { isEphemera: true, reason: "stub_brief", confidence: 0.99 };
  }

  for (const pattern of EPHEMERA_PROMPT_LIKE_PATTERNS) {
    if (likeToRegex(pattern).test(mem.body)) {
      return { isEphemera: true, reason: "dispatch_prompt_body", confidence: 0.99 };
    }
  }

  for (const pattern of runtimePatterns) {
    if (likeToRegex(pattern).test(mem.body)) {
      return { isEphemera: true, reason: "runtime_pattern", confidence: 0.95 };
    }
  }

  return { isEphemera: false };
}
