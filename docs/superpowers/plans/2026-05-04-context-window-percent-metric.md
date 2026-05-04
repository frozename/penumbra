# context-window-percent Metric — Implementation Plan

Date: 2026-05-04
Spec: `docs/superpowers/specs/2026-05-04-proactive-handoff-design.md` (Phase 5, deferred)
Status: Ready (signal source decided: transcript JSONL files)

## Pre-flight

- Tests: `import { expect, test } from 'bun:test';` — use `mkdtemp` from `node:fs/promises` for isolated transcript fixtures.
- Daemon does NOT need to restart between Phase 1 tasks. Phase 2 needs one restart at the end.
- **Signal source decision (closes the spec's open question):** read transcript token counts off the JSONL log files at `~/.claude/projects/<dir>/<session>.jsonl`. OTLP path is rejected for now — requires the user to enable Claude Code's OTLP export, plus our OTLP receiver is consumer-side; transcript JSONL is local, always-on, and matches the same data path the harness uses.

## Dispatch graph

```
1.1 → 1.2 → 1.3      (transcript reader → metric → schema enum)
2.1                  (playbook trigger update)
```

Phase 2 trivially small; could fold into 1.3 but kept separate so the playbook bump can be reverted independently if the threshold value needs tuning.

## Phase 1 — Metric pipeline

### Task 1.1 — Transcript token-count reader

```yaml meta
id: '1.1'
files:
  - packages/workflows/src/transcript-reader.ts
  - packages/workflows/test/transcript-reader.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

New module that reads Claude Code's transcript JSONL files and estimates the token count of the most-recently-modified one (per-project).

Public surface:

```ts
export type TranscriptInfo = {
  sessionId: string;
  path: string;
  estimatedTokens: number;
  modifiedAt: Date;
};

export function findActiveTranscriptForCwd(opts: {
  cwd: string;
  claudeProjectsRoot?: string;   // default `~/.claude/projects`
  now?: Date;
  staleAfterMin?: number;        // default 30 — older than this returns null
}): TranscriptInfo | null;
```

Implementation:
- Hash `cwd` to Claude Code's project-dir name. Read the source: Claude Code maps `cwd` to `~/.claude/projects/<dirname>` where `<dirname>` is `cwd.replace(/\//g, '-')` with leading-slash stripping. (Verify against existing claude-mem code in `~/.claude-mem/` or grep CLI source.)
- List `.jsonl` files in that dir; pick the one with the most recent mtime.
- If mtime older than `staleAfterMin`, return null (no active session).
- Estimate tokens by reading the file line-by-line (each line is a JSONL record), summing `text.length / 4` for `user` and `assistant` content blocks. Skip tool_use / tool_result blocks (they're noisy; the spec accepts an estimate).

Tests:
1. **No claude-projects dir** → returns null.
2. **No matching project subdir** → returns null.
3. **Empty subdir** → returns null.
4. **Single jsonl with 3 messages** → returns expected sessionId, estimatedTokens > 0.
5. **Two jsonl files, picks most recent** → asserts the picked one is the newer.
6. **Stale jsonl** (mtime older than `staleAfterMin`) → returns null.

For tests, use `mkdtemp` to build a fake `~/.claude/projects` root and pass it as `claudeProjectsRoot`.

**Commit:** `feat(workflows): transcript token-count reader for context-window metric`

### Task 1.2 — Add `context-window-percent` to StateMetrics

```yaml meta
id: '1.2'
files:
  - packages/workflows/src/poller.ts
  - packages/workflows/test/poller.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: schema-aware
```

Extend `StateMetrics` with `context-window-percent: number` (0–100, integer-rounded). Compute as `Math.min(100, Math.round((estimatedTokens / 200_000) * 100))` — assumes 200k context budget; threshold is human-set in the playbook.

In `computeStateMetrics`, accept an optional `transcriptReader: () => TranscriptInfo | null` injection (defaults to `findActiveTranscriptForCwd({ cwd: process.cwd() })`). On null, return 0 (no session = no pressure).

Tests: stub the reader for two cases — null returns 0; returns 100k tokens returns 50.

**Commit:** `feat(workflows): context-window-percent state metric from transcript reader`

### Task 1.3 — Schema enum + state-threshold trigger acceptance

```yaml meta
id: '1.3'
files:
  - packages/workflows/src/schema.ts
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Add `'context-window-percent'` to the `metric` enum on the `state-threshold` trigger.

No new tests — the existing trigger evaluator tests cover the enum extension implicitly when 2.1 wires it into a playbook.

**Commit:** `feat(workflows): context-window-percent in state-threshold metric enum`

## Phase 2 — Playbook trigger

### Task 2.1 — session-handoff playbook fires above 70% context

```yaml meta
id: '2.1'
files:
  - plugin/playbooks/session-handoff/playbook.md
file_scope: modify-existing
depends_on: ['1.3']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Append to the playbook's `triggers:` list:

```yaml
- kind: state-threshold
  metric: context-window-percent
  op: ">"
  value: 70
  poll_interval_s: 60
```

After commit + daemon restart, simulate a high-context state by writing a large transcript fixture to a temp dir and pointing `findActiveTranscriptForCwd` there via env var (or just commit the threshold and verify with a long real session).

**Commit:** `feat(playbooks): session-handoff fires when context-window-percent > 70`

## Acceptance criteria

1. `transcriptReader.findActiveTranscriptForCwd` returns the right session for the current cwd in a live Claude Code session.
2. `computeStateMetrics(...).context-window-percent` reports a non-zero value in the same conditions.
3. The session-handoff playbook fires automatically when transcript token count exceeds 140k (70% of 200k).
4. Existing tests stay green; new tests cover the reader, the metric, and the schema enum.

## Self-review

- Transcript-JSONL is the right signal. Local, always-on, matches what the harness already keeps. OTLP requires user opt-in.
- The 200k context budget is hardcoded; the right place for this constant is `packages/workflows/src/transcript-reader.ts` so it's discoverable. Future model bumps just change the constant.
- The mtime staleness check (default 30 min) protects against ghost transcripts from old sessions still on disk. If the user runs multiple Claude Code sessions in parallel, the most-recently-modified one wins — acceptable for the trigger's "most active session" semantics.
- Estimated total: 4 tasks, ~1h ship time. Smaller than Phase 1 of proactive-handoff.
