import { ValuePatternRedactor, type ValuePatternRule, type ValueRedactionHit } from '@penumbra/core';
import { MAESTRO_STATIC_RULES, buildUnknownAgentRule, isFailClosed } from './maestro-output-rules.js';

export type MaestroRedactionDecision = 'clean' | 'rewritten' | 'blocked' | 'bypassed';

export type MaestroRedactionResult = {
  decision: MaestroRedactionDecision;
  content: string;
  hits: ValueRedactionHit[];
  bypassed: boolean;
};

export type MaestroRedactionResultObject = {
  decision: MaestroRedactionDecision;
  value: unknown;
  hits: ValueRedactionHit[];
  bypassed: boolean;
};

export type MaestroOutputRedactorOptions = {
  knownAgents: Set<string>;
  bypass: boolean;
  /** Test-only injection of extra rules (e.g. soft / non-fail-closed). */
  extraRules?: ValuePatternRule[];
};

export class MaestroOutputRedactor {
  private readonly redactor: ValuePatternRedactor;
  private readonly bypass: boolean;

  constructor(opts: MaestroOutputRedactorOptions) {
    const rules = [
      ...MAESTRO_STATIC_RULES,
      buildUnknownAgentRule(opts.knownAgents),
      ...(opts.extraRules ?? []),
    ];
    this.redactor = new ValuePatternRedactor(rules);
    this.bypass = opts.bypass;
  }

  checkContent(text: string): MaestroRedactionResult {
    const { redacted, hits } = this.redactor.redactString(text);
    if (this.bypass) {
      return { decision: 'bypassed', content: text, hits, bypassed: true };
    }
    if (hits.length === 0) {
      return { decision: 'clean', content: redacted, hits, bypassed: false };
    }
    const blocked = hits.some((h) => isFailClosed(h.rule_id));
    return {
      decision: blocked ? 'blocked' : 'rewritten',
      content: redacted,
      hits,
      bypassed: false,
    };
  }

  checkValue<T>(value: T): MaestroRedactionResultObject {
    const { redacted, hits } = this.redactor.redactValue(value);
    if (this.bypass) {
      return { decision: 'bypassed', value, hits, bypassed: true };
    }
    if (hits.length === 0) {
      return { decision: 'clean', value: redacted, hits, bypassed: false };
    }
    const blocked = hits.some((h) => isFailClosed(h.rule_id));
    return {
      decision: blocked ? 'blocked' : 'rewritten',
      value: redacted,
      hits,
      bypassed: false,
    };
  }
}
