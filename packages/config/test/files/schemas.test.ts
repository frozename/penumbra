import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import type { AgentChatConfig as LegacyAgentChatConfig } from '../../../agentchat/src/config/types.js';
import { AgentsConfigSchema, type AgentsConfig } from '../../src/files/agents.js';
import { type AgentChatConfig } from '../../src/files/agentchat-types.js';
import { QuotasConfigSchema, type QuotasConfig } from '../../src/files/quotas.js';
import { RoutingConfigSchema, type RoutingConfig } from '../../src/files/routing.js';

function loadFixture(name: 'agents' | 'routing' | 'quotas'): string {
  return readFileSync(join(import.meta.dir, 'fixtures', `${name}.yaml`), 'utf8');
}

describe('AgentsConfigSchema', () => {
  test('valid fixture parses', () => {
    const parsed = AgentsConfigSchema.parse(parseYaml(loadFixture('agents')));
    expect(parsed).toMatchObject({
      agents: [
        {
          name: 'claude-acp-sonnet',
          adapter: 'stdio-acp',
          options: { requestTimeoutMs: 60000 },
          roles: ['executor', 'reviewer'],
          auto_approve_to: [],
          pricing_mode: 'api',
        },
      ],
      thoughts: { enabled: true },
      shell: { enabled: true },
    } satisfies Partial<AgentsConfig>);
  });

  test('unknown top-level key throws', () => {
    expect(() => AgentsConfigSchema.parse(parseYaml(`${loadFixture('agents')}\nfoo: bar\n`))).toThrow(/foo/);
  });

  test('missing required field throws', () => {
    const parsed = parseYaml(loadFixture('agents')) as { agents: Array<Record<string, unknown>> };
    delete parsed.agents[0]?.name;
    expect(() => AgentsConfigSchema.parse(parsed)).toThrow(/name/);
  });

  test('malformed type throws', () => {
    const parsed = parseYaml(loadFixture('agents')) as { agents: Array<Record<string, unknown>> };
    parsed.agents[0]!.options = { requestTimeoutMs: '60000' };
    expect(() => AgentsConfigSchema.parse(parsed)).toThrow(/requestTimeoutMs/);
  });
});

describe('RoutingConfigSchema', () => {
  test('valid fixture parses', () => {
    const parsed = RoutingConfigSchema.parse(parseYaml(loadFixture('routing')));
    const expected: RoutingConfig = {
      default_roles: {
        executor: 'claude-acp-sonnet',
        reviewer: 'codex-acp-deep',
        planner: 'gemini-acp-pro',
      },
      role_routing: { exploration_policy: 'unsampled-first' },
      skill_rosters: {
        review: {
          personas: ['architect', 'security', 'performance'],
          synthesizer: 'claude-acp-sonnet',
        },
        plan: {
          personas: ['architect', 'simplifier'],
          synthesizer: 'claude-acp-sonnet',
        },
      },
    };
    expect(parsed).toEqual(expected);
  });

  test('unknown top-level key throws', () => {
    expect(() => RoutingConfigSchema.parse(parseYaml(`${loadFixture('routing')}\nfoo: bar\n`))).toThrow(/foo/);
  });

  test('missing required field throws', () => {
    const parsed = parseYaml(loadFixture('routing')) as {
      skill_rosters: { review: Record<string, unknown> };
    };
    delete parsed.skill_rosters.review.synthesizer;
    expect(() => RoutingConfigSchema.parse(parsed)).toThrow(/synthesizer/);
  });

  test('malformed type throws', () => {
    const parsed = parseYaml(loadFixture('routing')) as { role_routing: Record<string, unknown> };
    parsed.role_routing.exploration_policy = 1;
    expect(() => RoutingConfigSchema.parse(parsed)).toThrow(/exploration_policy/);
  });
});

describe('QuotasConfigSchema', () => {
  test('valid fixture parses', () => {
    const parsed = QuotasConfigSchema.parse(parseYaml(loadFixture('quotas')));
    const expected: QuotasConfig = {
      providers: [
        {
          name: 'anthropic',
          model: 'claude-acp-sonnet',
          quota_usd_per_24h: 50,
          quota_tokens_per_24h: 5000000,
          quota_tokens_per_5h: 1000000,
          pressure_caps: {
            throttle_at: { warn: null, refuse: 80 },
          },
        },
      ],
    };
    expect(parsed).toEqual(expected);
  });

  test('unknown top-level key throws', () => {
    expect(() => QuotasConfigSchema.parse(parseYaml(`${loadFixture('quotas')}\nfoo: bar\n`))).toThrow(/foo/);
  });

  test('missing required field throws', () => {
    const parsed = parseYaml(loadFixture('quotas')) as { providers: Array<Record<string, unknown>> };
    delete parsed.providers[0]?.name;
    expect(() => QuotasConfigSchema.parse(parsed)).toThrow(/name/);
  });

  test('malformed type throws', () => {
    const parsed = parseYaml(loadFixture('quotas')) as { providers: Array<Record<string, unknown>> };
    parsed.providers[0]!.quota_usd_per_24h = '50';
    expect(() => QuotasConfigSchema.parse(parsed)).toThrow(/quota_usd_per_24h/);
  });
});

describe('AgentChatConfig type compatibility', () => {
  test('composite type remains structurally compatible with legacy AgentChatConfig', () => {
    type LegacyComparable = Pick<
      LegacyAgentChatConfig,
      'agents' | 'default_roles' | 'role_routing' | 'providers' | 'thoughts' | 'shell'
    >;

    expectTypeOf<AgentChatConfig>().toMatchObjectType<LegacyComparable>();
  });
});
