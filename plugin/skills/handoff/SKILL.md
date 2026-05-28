---
name: handoff
description: Use at end of session, on PreCompact, on Stop, or when explicitly asked to hand off — composes a continuation prompt that captures recent state, dispatch outcomes, and pending work so the next session can pick up cleanly.
---

# Handoff

End-of-session handoff. Two-step protocol — the workflow gives you raw skeleton; you write the narrative.

PreCompact and Stop hooks already trigger this skill automatically, so you do not need to invoke it explicitly in those cases. Treat explicit invocation as the fallback for manual checkpointing.

Use it explicitly when:

- The user says "hand off", "wrap up", or "let's end here"
- You are switching to a different project mid-session and want a clean checkpoint
- You are about to take an experimental detour and want a known-good return point

Skip it when:

- Hooks have already produced a handoff this turn
- The session is short and can be recovered from `git log` alone

## Step 1 — Pull the raw skeleton

```
mcp__penumbra__workflow_run({ "name": "session-handoff" })
```

The workflow returns:

- A composed prompt (git.log subjects, t2 memory titles, dispatch event timeline)
- Artifacts written to `docs/notes/maestro-continuation-{date}-{period}.md` (skip-if-exists) and `~/.penumbra/pending-handoff.md` (overwrite)

Treat the workflow's output as **scaffolding**, not the final note. It can aggregate facts but cannot tell the next maestro:

- _Why_ each commit was made (commit subjects ≠ commit context)
- Which dispatches were retries vs first-attempts, and why the first try failed
- What was live-edited (yaml, settings) outside git
- What was _decided to skip_ and why
- What activation/restart state is live right now
- What's queued for next session (open follow-ups with concrete first moves)

The playbook uses `{{repo_root}}` substitution so the generated prompt always points at the user's actual working directory, not the penumbra plugin repo.

## Step 2 — Write the narrative note yourself

Now write `docs/notes/maestro-continuation-{date}-{period}.md` using your conversation context. The path uses UTC date and `am`/`pm` per UTC noon. If a file already exists at that path AND its content does not reflect THIS session's commits, write to `-{period}-late.md` or `-{period}-2.md` instead — never blow away another session's note.

Required sections (skip any that are empty for this session — don't pad):

1. **Kickoff preamble** — same shape as the workflow output (`You are taking over as maestro in <repo>...`). Include MCP / no-sqlite / neutral-text / delegate-don't-implement reminders. Also include one line telling the next maestro to execute the **First moves** checklist (section 6) immediately in efficient order — batching independent calls in parallel — without asking for permission per item. Only pause on items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity ("decide whether to X"). The user already authorized the checklist by handing it over; do not re-litigate.

2. **What this session shipped** — for each commit since the session began:
   - Short rationale (the "why", not the "what" — readers see the diff)
   - Whether it was hand-coded or dispatched (and to whom, if dispatched)
   - Any retry history (e.g., "claude-acp-sonnet stalled mid-turn → re-dispatched to codex-acp-deep")
3. **Live state** — daemon/worker PIDs, anything you yaml-edited or daemon_reload_config'd, end-of-session quota numbers if relevant.
4. **Open follow-ups** — concrete next-session candidates with enough specificity to pick up cold (file paths, scope hints, why now).
5. **Memories worth reading** — the 3–6 t2 entries that future-you would actually want loaded first. (The workflow's recall already gave you a candidate list in Step 1.)
6. **First moves** — a numbered list of the literal first commands the next maestro should run.

## Step 3 — Save session-noteworthy memories

If this session surfaced a non-obvious bite, fix recipe, or design decision that future sessions would re-discover otherwise, write a memory file under `~/.claude/projects/<project>/memory/` and link it in `MEMORY.md`. (Same project memory directory that's loaded into your context at session start.)

## What NOT to do

- Don't accept the workflow's auto-rendered file as final — its narrative comes from FTS matches and event timelines, not from you. Always overwrite or supersede with your own narrative.
- Don't rely on `git log --oneline` subjects as documentation. Pair every commit with the conversational context that produced it.
- Don't dump raw dispatch events. Group by outcome and surface only the failures/retries that explain the path you took.
- Don't write the note in a way that requires the next session to re-derive what was already decided. The note exists so the next session doesn't have to re-research.

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
