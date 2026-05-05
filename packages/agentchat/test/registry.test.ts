import { describe, expect, test } from 'bun:test';
import { getAgentDescriptor } from '../src/registry.js';
import type { AgentChatConfig } from '../src/config/types.js';

const cfg: AgentChatConfig = {
  agents: [
    {
      name: 'codex',
      adapter: 'codex-cli',
      options: {},
      roles: [],
      auto_approve_to: [],
      tags: ['core', 'ts'],
      tier: 'oc',
      cost_cents_per_run: 12,
    },
  ],
  default_roles: {},
  providers: [],
  notifications: undefined,
  thoughts: undefined,
  shell: undefined,
};

describe('getAgentDescriptor', () => {
  test('returns descriptor for known agent', () => {
    expect(getAgentDescriptor('codex', cfg)).toEqual({
      name: 'codex',
      tags: ['core', 'ts'],
      tier: 'oc',
      cost_cents_per_run: 12,
    });
  });

  test('returns undefined for unknown agent', () => {
    expect(getAgentDescriptor('unknown', cfg)).toBeUndefined();
  });
});
