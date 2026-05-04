import type { GateInput, GateResult } from './index.js';

const COMPLETION_CLAIM_RE = /\b(done|complete|completed|finished|landed|shipped|works|fixed)\b/i;
const EVIDENCE_RE = /\b(ran|saw|verified|observed|tested|output|pass(ed)?|fail(ed)?)\b/i;
const HEDGE_RE = /\b(think|believe|should|probably|likely|might|maybe|presumably)\b/i;

export function verifyVerificationBeforeComplete(input: GateInput): GateResult {
  const text = input.text ?? '';
  const claimsCompletion = COMPLETION_CLAIM_RE.test(text);
  if (!claimsCompletion) {
    return { passed: true, evidence: 'no completion claim made', severity: 'blocking-in-session' };
  }
  const hasEvidence = EVIDENCE_RE.test(text);
  const hedges = HEDGE_RE.test(text);
  if (hasEvidence && !hedges) {
    return { passed: true, evidence: 'completion claim accompanied by run-and-saw evidence', severity: 'blocking-in-session' };
  }
  const flagged = text.match(HEDGE_RE)?.[0] ?? 'missing run-and-saw evidence';
  return {
    passed: false,
    evidence: `completion claimed but ${flagged}; gate requires explicit "ran X and saw Y" evidence`,
    severity: 'blocking-in-session',
  };
}
