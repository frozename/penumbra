---
name: handoff
description: Use at end of session, on PreCompact, on Stop, or when explicitly asked to hand off — composes a continuation prompt that captures recent state, dispatch outcomes, and pending work so the next session can pick up cleanly.
---

# Handoff

Use this skill to generate a next-session continuation prompt through the `session-handoff` playbook. The playbook delegates via `/handoff` and collects recent commits, pending handoffs from `mcp__penumbra__handoff_list_pending`, recent t2 memories, and the session's dispatch outcomes. The result is a paste-ready prompt block for the next run.

PreCompact and Stop hooks already trigger `/handoff` automatically, so you do not need to invoke it explicitly in those cases. Treat this skill as the fallback for explicit handoff requests and manual checkpointing.

Use it explicitly when:
- The user says "hand off", "wrap up", or "let's end here"
- You are switching to a different project mid-session and want a clean checkpoint
- You are about to take an experimental detour and want a known-good return point

Skip it when:
- Hooks have already produced a handoff this turn
- The session is short and can be recovered from `git log` alone

`/handoff` opens the playbook.

The playbook writes a continuation note to the repo's notes area, usually under `docs/notes/` or the equivalent path used by the user's repo conventions. It uses `{{repo_root}}` substitution so the generated prompt always points at the user's actual working directory, not the penumbra plugin repo.

## Filing task drafts (stumble-filing)

For handoff work, treat a stumble as any follow-up item, gap, bug, or design idea worth doing later that blocks the current focus.
Before filing, search `memory_search` for a similar pending task or existing draft and skip filing when the same work is already tracked.
If the stumble is still new, file it immediately with `mcp__penumbra__memory_observe` so the next session can pick it up cleanly.
Use `event_type: 'task_draft'` and include a fresh UUID v4 `draft_id`, a one-paragraph `prompt`, at least one `affects_projects` entry, and an `evidence` object with whatever `conv_ids`, `commits`, `files`, and `session_id` you have.
Set `auto_ok: false` by default; only set it to `true` for trivially safe items that do not need review.
Always set `filed_by_agent` to your agent name, `filed_via: 'skill_inline'`, and `parent_draft_id: null`.
Example MCP call shape:
`mcp__penumbra__memory_observe({ event_type: 'task_draft', payload_json: { draft_id: '01234567-89ab-cdef-0123-456789abcdef', prompt: '...', affects_projects: ['penumbra'], evidence: { conv_ids: [], commits: [], files: [], session_id: '...' }, auto_ok: false, filed_by_agent: 'claude', filed_via: 'skill_inline', parent_draft_id: null } })`
Keep the filing short and concrete, then return to the handoff flow.
