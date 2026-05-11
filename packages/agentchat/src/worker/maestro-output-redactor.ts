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

export type BuildMaestroRedactorFromEnvOpts = {
  env: Record<string, string | undefined>;
  knownAgents: Set<string>;
};

export function buildMaestroRedactorFromEnv(
  opts: BuildMaestroRedactorFromEnvOpts,
): MaestroOutputRedactor {
  const raw = opts.env.PENUMBRA_MAESTRO_REDACTION_BYPASS ?? '';
  const v = raw.toLowerCase();
  const bypass = v === '1' || v === 'true' || v === 'yes';
  return new MaestroOutputRedactor({
    knownAgents: opts.knownAgents,
    bypass,
  });
}

function mergeHits(into: Map<string, number>, hits: ValueRedactionHit[]): void {
  for (const h of hits) {
    into.set(h.rule_id, (into.get(h.rule_id) ?? 0) + h.count);
  }
}

export function walkAndRedact<T>(
  value: T,
  redactor: Pick<MaestroOutputRedactor, 'checkValue'>,
): MaestroRedactionResultObject {
  const hitCounts = new Map<string, number>();
  let blocked = false;
  let bypassed = false;
  let rewritten = false;

  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      const result = redactor.checkValue(input);
      mergeHits(hitCounts, result.hits);
      if (result.decision === 'blocked') {
        blocked = true;
        return input;
      }
      if (result.bypassed) {
        bypassed = true;
        return input;
      }
      if (result.decision === 'rewritten') {
        rewritten = true;
      }
      return result.value;
    }
    if (Array.isArray(input)) return input.map((v) => walk(v));
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return input;
  };

  const nextValue = walk(value) as T;
  const hits = [...hitCounts.entries()].map(([rule_id, count]) => ({ rule_id, count }));

  if (blocked) return { decision: 'blocked', value, hits, bypassed: false };
  if (bypassed) return { decision: 'bypassed', value, hits, bypassed: true };
  if (rewritten) return { decision: 'rewritten', value: nextValue, hits, bypassed: false };
  return { decision: 'clean', value: nextValue, hits, bypassed: false };
}
