export const AGENTCHAT_TEMPLATE = `# Penumbra agentchat config - seeded by 'penumbra init'.
# Edit freely. The plan-runtime sweeper requires at least one agent flagged
# 'maestro_capable: true' to dispatch leaf tasks.

agents:
  - name: openai-codex-fast-acp
    adapter: stdio-acp
    maestro_capable: true
    options:
      binary: codex-acp
    roles: [executor, planner]

  # Add more agents here. stdio-acp options take 'binary' and optional 'args'/'env'.
  # Common patterns:
  #   - anthropic-claude-sonnet-acp (binary: claude-agent-acp, env: { MAX_THINKING_TOKENS: "8000" })
  #   - gemini-acp        (binary: gemini, args: ['--acp'])
  #   - opencode-acp-*    (adapter: opencode-acp, binary: opencode-acp)
  # Mark each maestro_capable: true to allow plan-runtime to dispatch leaves to it.

default_roles:
  executor: openai-codex-fast-acp
  planner: openai-codex-fast-acp
`;
