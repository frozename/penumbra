# chain.cancel subprocess-kill audit

## Findings

- `POST /conversations/:id/cancel` persists `cancel_requested_at` and emits a worker control event for the active handoff, so the cancel request reaches the worker path. See [`packages/daemon/src/routes/conversations.ts`](../../../../packages/daemon/src/routes/conversations.ts#L15-L59).
- The worker control listener forwards `cancel` events into `dispatcher.cancel()`, and the dispatcher aborts the `AbortController` it passes to adapter dispatch. See [`packages/agentchat/src/worker/control-listener.ts`](../../../../packages/agentchat/src/worker/control-listener.ts#L41-L83) and [`packages/agentchat/src/worker/dispatcher.ts`](../../../../packages/agentchat/src/worker/dispatcher.ts#L68-L244).
- The CLI adapter path now performs explicit subprocess termination on abort: it sends `SIGTERM` immediately, then escalates to `SIGKILL` after `PENUMBRA_CANCEL_GRACE_S` seconds, defaulting to 10. See [`packages/agentchat/src/adapters/cli-spawn.ts`](../../../../packages/agentchat/src/adapters/cli-spawn.ts#L15-L83).

## Assessment

This path is now correct for cancellation semantics: a chain cancel reaches the worker, aborts the in-flight adapter call, and the adapter actively terminates the underlying CLI subprocess with a SIGTERM-to-SIGKILL fallback. Before the adapter change, the flow was only partial because it relied on abort propagation without an explicit kill escalation, so a subprocess that ignored termination could outlive the cancel request.

## Minimal fix

Keep the cancel propagation chain as-is, but own subprocess shutdown in `spawnCliAdapter`: register an `abort` listener, call `proc.kill('SIGTERM')` on abort, and schedule a `SIGKILL` after a short grace window so hung CLIs cannot stall cancellation forever. Make the grace configurable with `PENUMBRA_CANCEL_GRACE_S` and cover the ignore-SIGTERM case with a unit test.
