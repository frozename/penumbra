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

  # Devin CLI via its Zed ACP integration (exec verified live as of devin CLI
  # 3000.6.2: commands run through penumbra's ACP terminal/* surface, and the
  # model is client-selected via 'acp --model' — no server-side selection).
  # Install the Devin CLI separately and authenticate with
  # 'devin auth login' OR export WINDSURF_API_KEY in the worker/daemon
  # environment (stdio-acp inherits host env minus CLAUDE_* keys).
  #
  # Before dispatching: create a devin hygiene config file — it must disable
  # reading other tools' configs, attribution, subagents, and auto-update — and
  # replace the --config placeholder below with its ABSOLUTE path (stdio-acp
  # passes args verbatim; '~' is not expanded).
  #
  # roles: [] is deliberate. Roles are earned per-install after a smoke dispatch,
  # never seeded: a fresh install must not auto-route work to a seat whose smoke
  # gate has never run on this machine. NOT maestro_capable either: whether
  # 'devin acp' can drive penumbra MCP tools (task_complete / commits) is still
  # unverified.
  #
  # Model trap: only 'swe-1-7' and 'glm-5-2' are free. The bare 'swe' alias is
  # PAID — never seed it.
  - name: devin-swe-1-7-acp
    adapter: stdio-acp
    options:
      binary: devin
      args: [--config, /absolute/path/to/devin-acp-hygiene.json, --respect-workspace-trust, "false", acp, --model, swe-1-7]
    roles: []

  # Second free devin seat (same hygiene config, model swap only) — uncomment
  # once the preconditions above are met:
  # - name: devin-glm-5-2-acp
  #   adapter: stdio-acp
  #   options:
  #     binary: devin
  #     args: [--config, /absolute/path/to/devin-acp-hygiene.json, --respect-workspace-trust, "false", acp, --model, glm-5-2]
  #   roles: []

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
