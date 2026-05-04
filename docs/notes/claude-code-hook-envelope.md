# Claude Code hook output envelope — context injection

Date: 2026-05-04
Source: claude-code-guide subagent, official documentation reference.

## Which events accept context injection

| Event              | additionalContext stdout? | Notes |
| ------------------ | ------------------------- | ----- |
| SessionStart       | ✅                         | injected into first turn |
| UserPromptSubmit   | ✅                         | injected into the responding turn |
| PostToolUse        | ✅                         | injected after the tool completes |
| PreToolUse         | ❌ permission-only         | stdout controls deny/allow/ask/defer |
| Stop               | ❌                         | exit code + stderr only |
| PreCompact         | ❌                         | exit code + stderr only |

## Envelope shape

For SessionStart, UserPromptSubmit, PostToolUse:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Your context text here"
  }
}
```

`additionalContext` becomes part of the model's input for that turn. Treat it as a soft, advisory channel — the model can ignore it.

## Control fields (top-level)

```json
{
  "continue": true,
  "stopReason": "string (optional)",
  "suppressOutput": false,
  "systemMessage": "string (optional)",
  "hookSpecificOutput": { ... }
}
```

`systemMessage` is a top-level alternative for short banner-style messages; `additionalContext` is the right field for substantial context strings.

## Exit code semantics

| Exit code | Behaviour |
| --------- | --------- |
| 0         | stdout parsed as JSON; non-JSON or malformed JSON silently ignored |
| 2         | stderr shown as system message; the hook **blocks** the action |
| other     | non-blocking; first line of stderr shown to user; stdout ignored |

So a content-injection hook must `exit 0` and emit valid JSON.

## Size guidance

Not documented in the official reference. Keep `additionalContext` under ~2 KB per emission.

## PreToolUse stdout (for completeness)

PreToolUse uses a different `hookSpecificOutput` shape — permission control, not context:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny" | "allow" | "ask" | "defer",
    "permissionDecisionReason": "string",
    "updatedInput": { ... }
  }
}
```

This means the `delegate-suggest` workflow planned in `docs/superpowers/plans/2026-05-04-maestro-behavior-hooks.md` Task 4.2 needs to use a different mechanism than `additionalContext` — either downgrade to a Stop-event nag or piggyback on PostToolUse (after the edit), since PreToolUse can't inject reminders. Update the plan accordingly when executing 4.2.

## Verified / unverified

- Envelope shape: ✅ verified via Claude Code documentation.
- 2 KB recommended size: ⚠️ guidance only; not officially documented.
- Stable across recent versions: ✅ no breaking changes noted in the hook system since launch.
- End-to-end probe in this repo: ❌ not executed (would require restarting the session to observe a SessionStart effect). Document is authoritative enough for design purposes.

## Implications for the maestro-behavior-hooks plan

- Phase 3 (`session-reminder` output sink): emit `{ "hookSpecificOutput": { "hookEventName": <event>, "additionalContext": <text> } }` on stdout, exit 0. Wire into the existing `penumbra hook` command's stdout path — currently the hook command POSTs to `/workflows/trigger` and exits. Need to extend it so workflows triggered by lifecycle hooks can emit JSON to stdout that propagates back.
- Phase 4.1 (`prompt-classify`): UserPromptSubmit accepts `additionalContext`; design works as-is.
- Phase 4.2 (`delegate-suggest`): PreToolUse does NOT accept `additionalContext`. Pivot to PostToolUse retro-advice or a Stop-event nag. Update plan.
