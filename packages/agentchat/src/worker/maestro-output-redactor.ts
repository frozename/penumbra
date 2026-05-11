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

export const MAX_WALKER_DEPTH = 16;
export const MAX_WALKER_STRING_BYTES = 64 * 1024;
const WALKER_DEPTH_EXCEEDED_RULE_ID = 'walker_depth_exceeded';
const WALKER_STRING_OVERSIZE_RULE_ID = 'walker_string_oversize';

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

function addSyntheticHit(into: Map<string, number>, ruleId: string): void {
  into.set(ruleId, (into.get(ruleId) ?? 0) + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maxBytes) return text;
  return encoded.subarray(0, maxBytes).toString('utf8');
}

export type WalkAndRedactLimits = {
  maxDepth?: number;
  maxStringBytes?: number;
};

export function walkAndRedact<T>(
  value: T,
  redactor: Pick<MaestroOutputRedactor, 'checkValue'>,
  limits: WalkAndRedactLimits = {},
): MaestroRedactionResultObject {
  const hitCounts = new Map<string, number>();
  const maxDepth = limits.maxDepth ?? MAX_WALKER_DEPTH;
  const maxStringBytes = limits.maxStringBytes ?? MAX_WALKER_STRING_BYTES;
  let blocked = false;
  let bypassed = false;
  let rewritten = false;
  let depthExceededRecorded = false;
  let oversizeRecorded = false;

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) {
      if (!depthExceededRecorded) {
        addSyntheticHit(hitCounts, WALKER_DEPTH_EXCEEDED_RULE_ID);
        depthExceededRecorded = true;
      }
      return input;
    }
    if (typeof input === 'string') {
      const bytes = Buffer.byteLength(input, 'utf8');
      if (bytes > maxStringBytes) {
        if (!oversizeRecorded) {
          addSyntheticHit(hitCounts, WALKER_STRING_OVERSIZE_RULE_ID);
          oversizeRecorded = true;
        }
        const sampled = utf8Prefix(input, maxStringBytes);
        const result = redactor.checkValue(sampled);
        mergeHits(hitCounts, result.hits);
        if (result.decision === 'blocked') {
          blocked = true;
          return input;
        }
        if (result.bypassed) {
          bypassed = true;
          return input;
        }
        // Oversized strings are sampled for audit/blocking only; preserve original bytes.
        return input;
      }
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
    if (Array.isArray(input)) return input.map((v) => walk(v, depth + 1));
    if (isPlainObject(input)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = walk(v, depth + 1);
      }
      return out;
    }
    if (input && typeof input === 'object') {
      // Deliberately skip opaque instances (Date/Map/URL/etc). Tool payloads are
      // expected to be JSON-like; preserving type is safer than mutating instances.
      return input;
    }
    return input;
  };

  const nextValue = walk(value, 0) as T;
  const hits = [...hitCounts.entries()].map(([rule_id, count]) => ({ rule_id, count }));

  if (blocked) return { decision: 'blocked', value, hits, bypassed: false };
  if (bypassed) return { decision: 'bypassed', value, hits, bypassed: true };
  if (rewritten) return { decision: 'rewritten', value: nextValue, hits, bypassed: false };
  return { decision: 'clean', value: nextValue, hits, bypassed: false };
}
