# Discord webhook setup for penumbra worker notifications

## Create the webhook

1. In Discord, open the target channel.
2. Open `Edit Channel` -> `Integrations` -> `Webhooks`.
3. Create a webhook for the channel and copy the URL.

The value should look like:

```text
https://discord.com/api/webhooks/<webhook-id>/<webhook-token>
```

## Add the worker environment variable

The worker reads Discord notification settings from its launchd environment, not
from your interactive shell. Add the webhook URL to
`~/Library/LaunchAgents/dev.penumbra.worker.plist` under
`EnvironmentVariables`:

```xml
<key>PENUMBRA_DISCORD_WEBHOOK_URL</key>
<string>https://discord.com/api/webhooks/...</string>
```

Optional flags:

```xml
<key>PENUMBRA_DISCORD_QUIET</key>
<string>1</string>

<key>PENUMBRA_DISCORD_INCLUDE_PROMPT</key>
<string>1</string>
```

Notes:

- `PENUMBRA_DISCORD_QUIET=1` disables outbound Discord posts without removing
  the webhook URL.
- `PENUMBRA_DISCORD_INCLUDE_PROMPT=1` includes the dispatch prompt in embeds.
  Leave this unset unless you are comfortable sending prompt text to Discord.
- Setting the variable only in your shell will not affect the already-managed
  worker process.

## Reload the worker launch agent

After editing the plist, reload the worker so launchd applies the new
environment:

```bash
launchctl unload ~/Library/LaunchAgents/dev.penumbra.worker.plist
launchctl load ~/Library/LaunchAgents/dev.penumbra.worker.plist
```

Then verify it is back:

```bash
launchctl list | grep penumbra
```

## Smoke-test the webhook itself

Before testing penumbra, confirm the webhook accepts posts:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"content":"penumbra test"}' \
  "$PENUMBRA_DISCORD_WEBHOOK_URL"
```

Discord should return HTTP `204 No Content` and the message should appear in
the configured channel.

## Smoke-test penumbra notifications

1. Dispatch a small chain through `chain.start`.
2. Confirm a green Discord embed arrives when the handoff terminates.
3. Trigger a reconciler failure or PR-open flow and confirm the corresponding
   Discord embed arrives.

## Project routing, identities, and event coverage

`PENUMBRA_DISCORD_WEBHOOK_URL` continues to work as a single-channel default with
no extra configuration. To route notifications per project, customize per-agent
identity, or enable/disable individual event kinds, add a `notifications:` block
to `agentchat.yaml`:

```yaml
notifications:
  enabled: true
  prompt_policy: never        # never | summary | always
  channels:
    discord:
      kind: discord_webhook
      default_webhook_url_env: PENUMBRA_DISCORD_WEBHOOK_URL
  routes:
    projects:
      penumbra:
        channel: discord
        webhook_url_env: PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL
        prompt_policy: never
      other-project:
        channel: discord
        webhook_url_env: PENUMBRA_DISCORD_PROJECT_OTHER_WEBHOOK_URL
  identities:
    agents:
      codex:
        display_name: Penumbra / Codex
        avatar_url_env: PENUMBRA_DISCORD_AVATAR_CODEX_URL
      gemini:
        display_name: Penumbra / Gemini
        avatar_url_env: PENUMBRA_DISCORD_AVATAR_GEMINI_URL
  events:
    dispatch_start: false
    dispatch_end: true
    dispatch_failure: true
    watchdog_failure: true
    claim_retry: false
    adapter_retry_exhausted: true
    permission_requested: true
    permission_decided: true
    permission_expired: true
    merge_result: true
    cost_quota_summary: true
  summaries:
    cost_quota:
      enabled: true
      interval: daily         # daily | hourly
      channel: discord
```

Routing rules:

- `routes.projects.<id>` matches the dispatch's `project_id` exactly. Falls back
  to the default channel webhook when no project route matches.
- `identities.agents.<name>` overrides the Discord webhook `username` and
  `avatar_url` per agent. Falls back to the channel default when an agent has no
  identity entry.
- `events.<kind>` toggles individual event types. Defaults are high-signal:
  terminal failures, permission decisions, and cost summaries on; chatty events
  (dispatch_start, claim_retry) off.
- `summaries.cost_quota` schedules periodic cost/quota digest posts. Only
  `worker-primary` runs the scheduler; other workers are inert.

## Launchd env vars for routed webhooks and avatars

Every env var referenced under `webhook_url_env` or `avatar_url_env` must be
present in `~/Library/LaunchAgents/dev.penumbra.worker.plist`. Add them under
`EnvironmentVariables` alongside the default webhook:

```xml
<key>PENUMBRA_DISCORD_WEBHOOK_URL</key>
<string>https://discord.com/api/webhooks/<id>/<token></string>

<key>PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL</key>
<string>https://discord.com/api/webhooks/<id>/<token></string>

<key>PENUMBRA_DISCORD_PROJECT_OTHER_WEBHOOK_URL</key>
<string>https://discord.com/api/webhooks/<id>/<token></string>

<key>PENUMBRA_DISCORD_AVATAR_CODEX_URL</key>
<string>https://example.com/avatars/codex.png</string>

<key>PENUMBRA_DISCORD_AVATAR_GEMINI_URL</key>
<string>https://example.com/avatars/gemini.png</string>
```

Changing launchd env requires reloading the worker so it picks up the new
values. The implementation does not restart the worker automatically — use the
unload/load steps in the "Reload the worker launch agent" section above after
editing the plist.

## Operator CLI: `agentchat discord`

Validate, dry-run, and live-test notification config without dispatching a chain.
The three subcommands are `agentchat discord validate`, `agentchat discord render`,
and `agentchat discord test`.

```bash
# Walk the resolved channel + project routes; reports presence/absence only,
# never prints webhook URLs or tokens. Exit 0 if all referenced env vars
# resolve, 1 otherwise.
bun packages/agentchat/bin/agentchat.ts discord validate

# Render a sample event for a given route without posting anything.
# Useful for diffing template changes locally.
bun packages/agentchat/bin/agentchat.ts discord render \
  --event dispatch_end --project-id penumbra --agent codex

# Post a single sample dispatch_end embed to the resolved route via the live
# webhook. Use this to confirm the per-project / per-identity wiring after
# changing config or env vars. No retry on failure.
bun packages/agentchat/bin/agentchat.ts discord test \
  --project-id penumbra --agent codex
```

The `validate` subcommand prints lines like `default: configured`,
`project penumbra: configured`, or `env PENUMBRA_DISCORD_AVATAR_CODEX_URL: unset`.
Webhook URLs are never echoed.

## Privacy defaults

- `prompt_policy` defaults to `never`. Dispatch prompts are NOT included in
  embeds unless you explicitly set `summary` or `always` at the top level or on
  a per-project route.
- Permission events never include `raw_input`. Only the tool name, decision,
  TTL, and identifying IDs flow into Discord.
- Webhook URLs and tokens are never logged or printed by the worker, scheduler,
  or CLI; suppression decisions log the route's stable key only.

## Migration

- Existing setups with only `PENUMBRA_DISCORD_WEBHOOK_URL` keep working; no
  yaml changes required. The worker synthesizes a default `discord` channel
  from the env var.
- `PENUMBRA_DISCORD_QUIET=1` continues to suppress all delivery, regardless of
  the yaml `notifications.enabled` value.
- `PENUMBRA_DISCORD_INCLUDE_PROMPT=1` continues to flow through to
  `prompt_policy=always` semantics for the default route.
- New config can be adopted incrementally: start with `notifications.channels`
  + the same default env var, then add project routes, identities, event
  flags, and scheduled summaries as needed.

## Known gaps

- Watchdog Discord delivery is not yet end-to-end. The daemon emits
  `watchdog_failure` notification metadata via an optional in-process bus, but
  there is no SSE/HTTP transport for the worker to subscribe to those events
  and route them through the notification path. Until that bus exists,
  watchdog events stay daemon-side; permission, dispatch, and merge events are
  unaffected.

## Thought capture

The worker can capture per-adapter agent reasoning chunks as `agent.thought`
dispatch events, persist them in `dispatch_events`, and optionally run a digest
plus configurable signal extractors at merge time. Defaults are off.

### Enable capture

Add a `thoughts:` block to `agentchat.yaml`:

```yaml
thoughts:
  enabled: true
  capture:
    max_text_bytes: 16384
    max_stream_bytes: 1048576
    adapters:
      stdio-acp: true        # captures ACP agent_thought_chunk
      cli-spawn: false       # opt-in per-agent below if needed
    per_agent_overrides:
      claude-acp-sonnet: true
      gemini-acp-pro: false  # explicit off
```

For `stdio-acp` to actually receive thoughts, the underlying agent must emit
them. Today claude-acp-sonnet emits when `MAX_THINKING_TOKENS` is set in its
env (already configured in agentchat.yaml). Other ACP agents are upstream-blocked.

For `cli-spawn`, set `emit_stdout_thoughts: true` on a specific agent's
options block to enable parsing of `<thinking>…</thinking>` markers from
stdout.

### Enable analysis

Adds reconciler-time digest and signal extraction. Both run only when the
dispatch's merge status matches `only_when`:

```yaml
thoughts:
  enabled: true
  analyze:
    enabled: true
    only_when: [pr_opened, test_failed, typecheck_failed]
    digest:
      enabled: true
      agent: local-gemma26
      max_input_chars: 50000
      timeout_ms: 60000
    signals:
      enabled: true
      agent: local-gemma26
      timeout_ms: 60000
      definitions:
        - name: uncertainty
          prompt: "List excerpts where the agent expressed doubt about its approach…"
        - name: security
          prompt: "List places where the agent flagged a security risk and how it resolved it…"
```

### Inspecting captured thoughts

```bash
# Live (during dispatch): see thought events flow through SSE
penumbra dispatch timeline <handoff_id>

# After merge: digest + signal events appear in the same timeline
penumbra dispatch timeline <handoff_id> | grep agent.thought
```

### Privacy notes

- `agent.thought` text is run through a credential-redaction pre-filter (api
  keys, github tokens, discord webhooks, bearer tokens) before persistence.
  Best-effort; do not rely on it.
- The original dispatch prompt is NOT stripped from thought text. If your
  prompts are sensitive, set `thoughts.capture.adapters.<adapter>: false` or
  `per_agent_overrides.<name>: false` for that workload.
- Thoughts inherit the existing `dispatch_events` retention policy.

### Disable

Set `thoughts.enabled: false` (or omit the block). The capture pipeline is
dead code in this state; no events are written.

## Shell session tools

The daemon can expose a per-handoff stateful shell to ACP-class agents through
three new MCP tools: `mcp__penumbra__shell_run`, `mcp__penumbra__shell_close`,
`mcp__penumbra__shell_list`. Sessions persist for the duration of one handoff;
state (cwd, env, exported variables) survives across `shell_run` calls within
a dispatch. Defaults are off.

### Enable shell tools

Add a `shell:` block to `agentchat.yaml`:

```yaml
shell:
  enabled: true
  max_sessions_per_handoff: 4
  max_session_idle_ms: 600000
  max_command_duration_ms: 60000
  output_byte_limit: 1048576
  redact_output: true
  unset_env: []
  dangerous_commands:
    - 'sudo\b'
    - '\brm\s+-rf\b'
    - '\bgit\s+push\b'
    - 'curl[^|]*\|\s*(sh|bash)\b'
    - '\bdd\b.*\bof=\s*/dev/'
  per_agent_overrides:
    claude-acp-sonnet:
      dangerous_commands_extra:
        - '\bgh\s+pr\s+merge\b'
```

### Permission model

- First `shell_run` for a session fires a `permission/request` with
  `tool_name: 'shell_run'`. Operator approves once per session.
- Approved sessions skip the prompt for subsequent commands within the same
  session, until the permission TTL expires.
- Commands matching any pattern in `dangerous_commands` (or the agent's
  `dangerous_commands_extra`) re-prompt with `tool_name: 'shell_run.dangerous'`.
  Approval is per-call; not cached.
- `auto_approve_to: ['shell_run']` per-agent skips the session-level prompt.
  The dangerous-command prompt still fires.

### Privacy notes

- Stdout/stderr are run through credential redaction (api keys, github tokens,
  discord webhooks, bearer tokens) before reaching the agent and before any
  logging. Set `shell.redact_output: false` or
  `shell.per_agent_overrides.<agent>.redact_output: false` to disable for
  trusted workflows.
- `shell.run` dispatch events log the command (truncated to 1 KB) plus session
  id, exit code, duration, and the `truncated` flag. Output bytes are NEVER
  persisted.
- Sessions inherit the daemon process env minus `unset_env` keys plus any
  explicit `env` override. They run as the daemon UID; same trust boundary as
  `terminal/create`.

### Inspecting sessions

```bash
penumbra dispatch timeline <handoff_id> | grep shell.
```

### Disable shell tools

Set `shell.enabled: false` (or omit the block). The three MCP tools are not
registered with the agent's penumbra-mcp instance; the agent gets
`unknown_tool` if it tries to call them.
