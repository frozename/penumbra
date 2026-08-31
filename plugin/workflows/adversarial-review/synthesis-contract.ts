export const SYNTHESIS_VERDICT_PATTERN =
  /\b(?:land(?:ed)?\s+as-is|land(?:ed)?\s+with\s+revisions|be\s+rejected|reject(?:ed)?)\b/i;

export const SYNTHESIS_VERDICT_INSTRUCTION =
  "one sentence: should this change land as-is, with revisions, or be rejected?";

export const SYNTHESIS_OUTPUT_SECTIONS = [
  {
    label: "Shared concerns",
    instruction: 'issues raised by 2+ personas (or "none - single persona" if only one).',
  },
  {
    label: "Contradictions",
    instruction: 'where personas disagreed (or "none").',
  },
  {
    label: "Severity-ranked findings",
    instruction:
      "combine all personas' JSON findings into one flat ranked list (high -> low). Dedupe near-identical findings; cite which personas raised each.",
  },
  {
    label: "Recommended actions",
    instruction: "concrete, ordered. Each action references finding numbers.",
  },
  {
    label: "Skipped/failed personas",
    instruction: "note any DISPATCH FAILED entries with their reason.",
  },
] as const;

export const REQUIRED_SYNTHESIS_SECTION_LABELS = SYNTHESIS_OUTPUT_SECTIONS.map(
  (section) => section.label,
);
