# session-handoff-draft

Drafts two judgment sections for the current `session-handoff` skeleton:

- `## Narrative and traps learned`
- `## Open follow-ups (worst-first)`

The workflow runs on chain-capable triggers only: lifecycle `pre-compact` and slash
`handoff`. State-threshold triggers stay on `session-handoff` because the daemon sweeper
context cannot dispatch chains for ts-function workflows.

The workflow is role-routed through `initial_agent: "executor"` with `tool_free: true`,
`use_worktree: false`, and `max_hops: 1`. It registers the draft for operator approval
through `session_note_drafts`, supersedes older awaiting drafts for the same period, then
atomically renames a sibling temp file into the final `.draft.md` path.

Failure is fail-closed: if the current-period skeleton is absent, dispatch is unavailable,
the chain times out, or the response is malformed, the workflow returns a skipped result and
leaves the skeleton unchanged without writing a draft row.
