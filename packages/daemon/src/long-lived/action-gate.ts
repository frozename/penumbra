import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { extractActionTarget } from './target-extractors.js';

const BASELINE_TIERS: Array<{ match: RegExp; tier: 1 | 2 | 3 }> = [
  { match: /^ha:state\./, tier: 1 },
  { match: /^ha:(light|switch|climate)\./, tier: 1 },
  { match: /^ha:script\.run$/, tier: 1 },
  { match: /^ha:snapshot\.(create|list)$/, tier: 1 },
  { match: /^ha:dashboard\./, tier: 2 },
  { match: /^ha:automation\.(set|delete)$/, tier: 2 },
  { match: /^ha:snapshot\.restore$/, tier: 2 },
  { match: /^ha:integration\./, tier: 3 },
];

function baselineTier(tool: string): 1 | 2 | 3 {
  for (const rule of BASELINE_TIERS) {
    if (rule.match.test(tool)) return rule.tier;
  }
  return 1;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function classifyTier(input: {
  tool: string;
  target: string;
  agentGlobs: readonly string[];
}): 1 | 2 | 3 {
  const targetVariants = [input.target];
  const dotIndex = input.target.indexOf('.');
  if (dotIndex >= 0 && dotIndex + 1 < input.target.length) {
    targetVariants.push(input.target.slice(dotIndex + 1));
  }
  for (const glob of input.agentGlobs) {
    const matcher = globToRegExp(glob);
    if (matcher.test(input.tool)) return 3;
    for (const target of targetVariants) {
      if (matcher.test(`${input.tool}:${target}`)) return 3;
      if (matcher.test(target)) return 3;
    }
  }
  return baselineTier(input.tool);
}

export function cooldownMsFor(tool: string, overrides: Record<string, number>): number {
  for (const [glob, ms] of Object.entries(overrides)) {
    if (globToRegExp(glob).test(tool)) return ms;
  }
  return 600_000;
}
