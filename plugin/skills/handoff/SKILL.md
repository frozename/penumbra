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
