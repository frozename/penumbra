# @penumbra/agentchat

Cross-agent group-chat orchestrator. Lets Claude / Gemini / Codex / local
LLMs talk to each other via `@mention`s, with the human in the loop only
to approve handoffs.

## Quick start

1. Make sure penumbra is running:
   ```
   penumbra init && penumbra start
   ```
2. Write `~/.config/agentchat/agentchat.yaml`:
   ```yaml
   agents:
     - name: claude
       adapter: claude-cli
       options: { command: claude, args: ["-p"], pass_via: argv }
       roles: [planner, reviewer]
     - name: gemini
       adapter: gemini-cli
       options: { command: gemini, args: ["-p"], pass_via: argv }
       roles: [executor]
     - name: codex
       adapter: codex-cli
       options: { command: codex, args: ["exec"], pass_via: argv }
       roles: [reviewer]
     - name: local
       adapter: openai-compat-http
       options:
         baseUrl: https://192.168.68.76:7843/v1
         api_key_env: LLAMACTL_TOKEN_LOCAL
         model: gemma-4-E4B-it-GGUF/...
       roles: [reviewer]

   default_roles:
     planner: claude
     executor: gemini
     reviewer: codex
   ```
3. Run a conversation:
   ```
   agentchat new my-project
   > Add rate limiting to /api/login
   ```

## Commands

- `agentchat new [project]` — start a new conversation
- `agentchat queue` — list pending handoffs
- `agentchat approve <id> [--redirect <name>]` — approve or redirect
- `agentchat reject <id> [--reason <text>]` — reject

## Mention semantics

- `@<role>` (e.g. `@executor`) → resolves via `default_roles`
- `@<name>` (e.g. `@gemini`) → resolves to the literal agent
- Role wins over name when both could match

## Adapters

Built-in: `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`.
Add your own by importing `Adapter`, `registerAdapter` from
`@penumbra/agentchat`.