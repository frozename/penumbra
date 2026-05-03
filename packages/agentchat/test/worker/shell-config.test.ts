import { describe, expect, it } from 'bun:test';
import { AgentChatConfigSchema } from '../../src/config/types.js';
import { loadShellConfig } from '../../src/worker/shell-config.js';

describe('shell config schema', () => {
  it('accepts a minimal shell block', () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: 'codex', adapter: 'codex-cli' }],
      shell: {
        enabled: true,
        max_sessions_per_handoff: 4,
        dangerous_commands: ['sudo\\b'],
      },
    });
    expect(parsed.shell?.enabled).toBe(true);
    expect(parsed.shell?.dangerous_commands).toEqual(['sudo\\b']);
  });
});

describe('loadShellConfig', () => {
  it('returns a disabled config when no shell block is present', () => {
    const cfg = loadShellConfig({
      agentchat: { agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }], default_roles: {}, providers: [] },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxSessionsPerHandoff).toBe(4);
    expect(cfg.outputByteLimit).toBe(1048576);
    expect(cfg.redactOutput).toBe(true);
    expect(cfg.dangerousCommands).toContain('sudo\\b');
    expect(cfg.dangerousCommands).toContain('\\brm\\s+-rf\\b');
  });

  it('merges per-agent dangerous_commands_extra into the global list', () => {
    const cfg = loadShellConfig({
      agentchat: {
        agents: [{ name: 'claude-acp-sonnet', adapter: 'stdio-acp', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        shell: {
          enabled: true,
          dangerous_commands: ['sudo\\b'],
          per_agent_overrides: {
            'claude-acp-sonnet': { dangerous_commands_extra: ['\\bgh\\s+pr\\s+merge\\b'] },
          },
        },
      },
    });
    const patterns = cfg.dangerousCommandsForAgent('claude-acp-sonnet');
    expect(patterns).toContain('sudo\\b');
    expect(patterns).toContain('\\bgh\\s+pr\\s+merge\\b');
    expect(cfg.dangerousCommandsForAgent('codex')).not.toContain('\\bgh\\s+pr\\s+merge\\b');
  });

  it('preserves caps from the config', () => {
    const cfg = loadShellConfig({
      agentchat: {
        agents: [{ name: 'a', adapter: 'stdio-acp', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        shell: {
          enabled: true,
          max_sessions_per_handoff: 8,
          max_session_idle_ms: 300000,
          max_command_duration_ms: 30000,
          output_byte_limit: 524288,
          redact_output: false,
        },
      },
    });
    expect(cfg.maxSessionsPerHandoff).toBe(8);
    expect(cfg.maxSessionIdleMs).toBe(300000);
    expect(cfg.maxCommandDurationMs).toBe(30000);
    expect(cfg.outputByteLimit).toBe(524288);
    expect(cfg.redactOutput).toBe(false);
  });
});
