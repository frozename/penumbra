export const WELL_FORMED_SYNTHESIS = `Land with revisions: address the high-severity regression before landing.

## Shared concerns
- Security and performance both flagged the same broken invariant.

## Contradictions
none

## Severity-ranked findings
1. high: Broken invariant (security, performance)

## Recommended actions
1. Fix finding 1 before landing.

## Skipped/failed personas
none`;

export const REAL_2026_08_31_SYNTHESIS_WITH_QUALIFIED_HEADINGS = `Land with revisions: address the reproduced validation regression before landing.

## Shared concerns (2+ personas):
- Multiple personas flagged that valid syntheses with qualified headings are rejected.

## Contradictions:
none

## Severity-ranked findings:
1. high: Qualified section headings are rejected by synthesis validation (architect, integration).

## Recommended actions (ordered):
1. Fix finding 1 before landing.

## Skipped/failed personas:
none`;

export const REAL_2026_08_31_SYNTHESIS_WITH_PREAMBLE = `Synthesis follows from the completed persona reviews.

This change should be landed with revisions after the validator and status issues are fixed.

## Shared concerns (2+ personas):
- Reviewers agreed the fail-closed validator rejects genuine output and accepts empty headings.

## Contradictions:
none

## Severity-ranked findings:
1. high: The verdict check only reads the first line, misclassifying preamble-prefixed synthesis (security, integration).

## Recommended actions (ordered):
1. Fix finding 1 before landing.

## Skipped/failed personas:
none`;

export const EMPTY_HEADING_SYNTHESIS = `Land with revisions: this shell has every required heading but no section substance.

## Shared concerns

## Contradictions

## Severity-ranked findings

## Recommended actions

## Skipped/failed personas`;
