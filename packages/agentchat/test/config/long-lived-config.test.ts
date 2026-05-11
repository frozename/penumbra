import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';

const yamlSample = `
agents:
  - name: home-mgmt
    display_name: "Home Management"
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      schedule_cron: "*/15 * * * *"
      subscriptions:
        - { server: ha, event: state_changed }
      mcp_allowlist:
        - "ha:state.*"
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      circuit_breaker_threshold: 3
      action_tiers:
        approval_required_globs: ["ha:integration.*"]
        cooldown_overrides: { "ha:dashboard.*": 60000 }
      hosted_mcp_servers:
        - name: local-mcp
          command: node
          args: ["server.js"]
          env:
            - name: TOKEN
              value: ""
      standing_brief: "be helpful"
  - name: regular-coder
    adapter: claude-cli
`;

function loadYaml(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-long-lived-'));
  const file = join(dir, 'agentchat.yaml');
  writeFileSync(file, yaml);
  return loadConfig(file);
}

describe('agentchat.yaml long-lived extension', () => {
  it('parses an entry with long_lived_config', () => {
    const parsed = loadYaml(yamlSample);
    const home = parsed.agents.find((a) => a.name === 'home-mgmt')!;
    expect(home.long_lived).toBe(true);
    expect(home.long_lived_config!.schedule_cron).toBe('*/15 * * * *');
    expect(home.long_lived_config!.subscriptions).toEqual([{ server: 'ha', event: 'state_changed' }]);
    expect(home.long_lived_config!.bounds.wall_clock_ms).toBe(180000);
    expect(home.long_lived_config!.action_tiers!.approval_required_globs).toContain('ha:integration.*');
    expect(home.long_lived_config!.action_tiers!.cooldown_overrides!['ha:dashboard.*']).toBe(60000);
    expect(home.long_lived_config!.hosted_mcp_servers).toEqual([
      {
        name: 'local-mcp',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'TOKEN', value: '' }],
      },
    ]);
  });

  it('non-long-lived agents have undefined long_lived_config', () => {
    const parsed = loadYaml(yamlSample);
    const reg = parsed.agents.find((a) => a.name === 'regular-coder')!;
    expect(reg.long_lived).toBeUndefined();
    expect(reg.long_lived_config).toBeUndefined();
  });

  it('rejects a long_lived entry without standing_brief', () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    long_lived_config:
      schedule_cron: "*/1 * * * *"
`;
    expect(() => loadYaml(bad)).toThrow();
  });

  it('rejects invalid cron syntax', () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    long_lived_config:
      schedule_cron: "not-a-cron"
      standing_brief: "x"
`;
    expect(() => loadYaml(bad)).toThrow();
  });

  it('rejects malformed hosted_mcp_servers entries', () => {
    const bad = `
agents:
  - name: bad
    long_lived: true
    adapter: claude-cli
    long_lived_config:
      mcp_allowlist: []
      bounds:
        wall_clock_ms: 180000
        cost_cents: 50
        max_sub_dispatches: 0
      standing_brief: "x"
      hosted_mcp_servers:
        - name: bad-server
          command: ""
`;
    expect(() => loadYaml(bad)).toThrow();
  });
});
