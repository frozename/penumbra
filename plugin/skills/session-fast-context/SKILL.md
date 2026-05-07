---
name: session-fast-context
description: Use at session start, before answering anything substantive — auto-load the most recent maestro-continuation note, last 5 commits, `mcp__penumbra__handoff_list_pending`, and 3-5 recall hits relevant to the user's first message.
---

# Session Fast Context

At session start, the orchestrator is cold. Without a context prime, every response re-derives branch state, handoff state, and recent intent from scratch. This skill loads the minimum viable context bundle so the first response is informed.

## Auto-Load Sequence

1. Last few commits on the current branch: `git log --oneline -5`.
2. Pending handoffs: `mcp__penumbra__handoff_list_pending`. If anything is in flight or pending approval, surface it before doing other work.
3. Most recent continuation note in the user's repo, typically under `docs/notes/maestro-continuation-*`. Prefer the file matching today's date or the most recent date; if the convention differs, fall back to the repo's continuation or handoff note pattern.
4. 3-5 recall hits via `mcp__penumbra__memory_search` keyed on the user's first message or the active branch / pending-handoff topic.

## Heavy Lifting

`plugin/playbooks/maestro-context-prime` does the substantive work. Its template vars include `{{repo_root}}`, so the prompt always points at the user's actual working directory. This skill is only the trigger surface; the playbook is the substance.

## When To Skip

- Mid-session continuation where context is already loaded.
- The user's first message is trivial, like "what's 2+2" or "hello".
- Hooks have already fired the context prime this session.

## Hand-Off

After the prime lands, defer to `maestro-recall-prime` for any subsequent pre-action recall.
