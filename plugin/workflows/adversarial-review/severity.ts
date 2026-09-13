type PersonaFindings = {
  findings: unknown[] | null | undefined;
};

type PersonaSeverityCounts = {
  high: number;
  medium: number;
  low: number;
  unparsed: boolean;
};

export function countPersonaSeverity(
  findings: unknown[] | null | undefined,
): PersonaSeverityCounts {
  let high = 0;
  let medium = 0;
  let low = 0;
  let unparsed = false;

  if (!Array.isArray(findings)) {
    return { high: 0, medium: 0, low: 0, unparsed: true };
  }

  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) {
      unparsed = true;
      continue;
    }

    const severity = (finding as Record<string, unknown>).severity;
    if (typeof severity !== "string") {
      unparsed = true;
      continue;
    }

    const normalized = severity.trim().toLowerCase();
    if (normalized === "high") {
      high += 1;
    } else if (normalized === "medium") {
      medium += 1;
    } else if (normalized === "low") {
      low += 1;
    } else if (normalized === "info") {
      // Info findings are intentionally not counted toward high/medium/low.
    } else {
      unparsed = true;
    }
  }

  return { high, medium, low, unparsed };
}

export function summarizeSeverityMetrics(personas: PersonaFindings[]): {
  high_count: number;
  medium_count: number;
  low_count: number;
  severity_unparsed_personas: number;
} {
  let high_count = 0;
  let medium_count = 0;
  let low_count = 0;
  let severity_unparsed_personas = 0;

  for (const persona of personas) {
    const counts = countPersonaSeverity(persona.findings);
    high_count += counts.high;
    medium_count += counts.medium;
    low_count += counts.low;
    if (counts.unparsed) severity_unparsed_personas += 1;
  }

  return { high_count, medium_count, low_count, severity_unparsed_personas };
}
