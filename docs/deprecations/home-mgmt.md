# Home Assistant operator retirement

Penumbra's `home-mgmt` operator is retired. Home monitoring and device control belong in a dedicated project if pursued again. Task refinement and other configured operators continue using the existing long-lived runtime.

## Behavior after upgrade

- The daemon ignores `home-mgmt` in the agent configuration. It does not register its cron jobs, event subscriptions, or hosted MCP servers.
- Reconciliation marks an existing `home-mgmt` database row as retired. Keeping an obsolete YAML entry cannot reactivate it. New installations do not create a row for it.
- Resume, direct or role-routed dispatch, and sub-dispatches carrying the retired identity are rejected with `agent_retired`. The operator cannot start ticks or execute new or previously approved actions. Pending actions cannot be approved, but can still be inspected and rejected.
- Stored working memory, ticks, pending actions, and audit history remain available through the existing read APIs. No historical rows are deleted.
- Generic tick prompts no longer contain Home Assistant-specific instructions. Shared action tiers and target extraction remain in place for other configured integrations until their consumers migrate.

This retirement is specific to the former built-in ID `home-mgmt`. It does not disable an independently configured Home Assistant integration under another agent name.

## Deployment cleanup

Before activating the new runtime:

1. Inspect `home-mgmt` state, ticks, pending actions, and audit history with `penumbra long-lived` or the corresponding MCP tools. Export any state needed for a future project.
2. Pause the operator to prevent new ticks. Drain any running tick and its sub-dispatches, or cancel their chains through the normal chain controls. Pausing and retiring are status changes; they do not terminate an existing subprocess or undo an external action.
3. Reject remaining pending actions. Check approved actions for work that has already executed before cancelling any unfinished work.
4. Remove the `home-mgmt` entry from `~/.config/penumbra/agents.yaml` (or the legacy agentchat YAML), including its hosted MCP configuration. Remove only credentials and server configuration that are exclusive to this operator.
5. Upgrade and restart the daemon and worker together using the normal source-install update procedure. Reconnect MCP clients to activate their new tool handlers.
6. Confirm that `home-mgmt` is absent from the non-retired operator list, that its historical detail remains readable, and that both task refiners retain their expected status.

The runtime guards also protect installations that still contain the obsolete entry. They cannot stop a previous daemon, worker, or MCP process that is still running old code, nor reverse a tool call that was already in progress. Complete the drain and activation steps before treating the deployment as retired.

## Later removal

Migrate task refinement and any custom operators before deleting the shared runtime. Workflows currently have no cron trigger, so scheduled refinement needs an explicit scheduler or an internal periodic worker. Preserve historical state and exportability when removing the runtime. A future home assistant project should define its own monitoring, approval, backup, and recovery requirements before extracting reusable infrastructure.
