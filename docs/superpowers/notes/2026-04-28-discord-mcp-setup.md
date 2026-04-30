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
