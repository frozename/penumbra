# Recall Cookbook

Recipes for the penumbra recall surface: 3-layer search, knowledge corpora, hybrid recall, by-file recall, and health snapshots. Tool names match the MCP registrations in `packages/mcp/src/server.ts`.

## 3-layer search workflow (token-efficient)

When you only need to find a few specific observations, scanning a full `memory.recall` payload is wasteful — every hit hydrates the full body. The 3-layer chain is built so the cheap step does the filtering and only the IDs you actually want get hydrated.

1. **`memory.search`** — compact index over `t1_fts` / `t2_fts` with metadata filters. Returns `{ id, title, snippet, score, ts, obs_type? }` per hit.
2. **`memory.timeline`** — chronological neighbors around an anchor t2 id. Use to see what happened just before/after an interesting hit.
3. **`memory.get_observations`** — batch-hydrate full bodies for a list of IDs. Always batch; do not call once per ID.

Example — "what did we decide about the watchdog?":

```jsonc
// Step 1 — index
memory.search({
  query: "stdio-acp watchdog timeout",
  obs_type: "decision",
  limit: 20
})
// → [{ id: "t2:12519", title: "stdio-acp Watchdog Now Re-arms…", score: 0.81, … }, …]

// Step 2 — context around the most relevant hit
memory.timeline({ anchor: "t2:12519", depth_before: 3, depth_after: 3 })
// → ordered list of nearby t1/t2 ids with titles

// Step 3 — only hydrate what you'll actually read
memory.get_observations({ ids: ["t2:12519", "t2:12521", "t2:12527"] })
```

Prefer this over `memory.recall` whenever you can answer the question from titles + a small set of bodies. Use `memory.recall` when you genuinely want the top-K bundle for prompt injection (the recall_context flow does this).

## Knowledge corpora

A corpus is a named, persisted bundle of t2 observations matching a metadata filter. Build it once, query it many times — the bundle survives across recalls and can be wired into a worker via `agentchat.yaml.recall_context.scope: corpus:<name>`.

The two primary calls:

```jsonc
memory.corpus_build({
  name: "acp-work",
  filter: {
    concept: "acp",          // any concept tag the writer attached
    // project_id: "penumbra",
    // obs_type: "bugfix",   // any ObsTypeEnum value
    // file_path: "packages/agentchat/src/adapters/stdio-acp.ts",
    // dateStart: "2026-04-15",
    // dateEnd:   "2026-05-04",
    // limit: 200
  }
})
// → { name: "acp-work", member_count: 47, created_at: "2026-05-04T12:33:43Z" }

memory.corpus_query({ name: "acp-work", query: "watchdog re-arm semantics", k: 8 })
// → same hit shape as memory.search, but constrained to corpus members
```

`memory.corpus_list` enumerates existing corpora with their member counts and creation timestamps. Filter fields are AND-combined; omit a field to leave it unconstrained.

To prime a worker on the ACP slice:

1. `memory.corpus_build({ name: "acp-work", filter: { concept: "acp" } })`
2. In `~/.config/agentchat/agentchat.yaml`, set:

   ```yaml
   recall_context:
     enabled: true
     scope: corpus:acp-work
     k: 5
   ```

3. Reload the daemon (`penumbra daemon reload-config` or restart).

## Hybrid recall (Phase 4)

`memory.recall({ query, strategy_hint: 'hybrid', filter: { … } })` runs a SQL metadata pre-filter against the typed columns (`obs_type`, `concepts`, `severity`, `file_paths`, project, date range), then vector-reranks the surviving rows. Default RRF blends FTS + vector across the full corpus and is broader; hybrid is sharper when you already know the slice you care about (for example "decisions on file X this week"). Pick hybrid when the filter alone would already narrow the corpus to a few hundred rows — RRF on top of a known slice is wasted work.

## By-file recall

Phase 2 added a `t0_file_refs` index that maps file paths to the observations that touched them. CLI:

```bash
penumbra recall "watchdog regression" --file packages/agentchat/src/adapters/stdio-acp.ts --limit 10
```

Equivalent MCP call:

```jsonc
memory.search({
  query: "watchdog regression",
  file_path: "packages/agentchat/src/adapters/stdio-acp.ts",
  limit: 10
})
```

The `--file` flag also chains through `memory.recall` and `memory.corpus_build({ filter: { file_path: ... } })`. Use it when you're auditing a specific file's history rather than a topic.

## Health snapshot

`memory.status` returns a single JSON snapshot of recall corpus health — useful before kicking off a backfill or after a schema migration.

```jsonc
memory.status({})
// → {
//   t0: 16023,
//   t1: 1161,
//   t2: 5,
//   t1_unpromoted: 1028,
//   t1_failed: 41,
//   t2_by_obs_type: { bugfix: 2, decision: 1, … },
//   t2_by_severity: { high: 1, … },
//   corpora_count: 1,
//   last_recall_audit: "2026-05-04T12:33:43.828Z"
// }
```

A non-zero `t1_failed` or a stale `last_recall_audit` is the signal to investigate; a large `t1_unpromoted` is the signal to run promotion.

## Workflow runtime

The workflow runtime exposes:

- `workflow.list` — registry contents
- `workflow.run({ name })` — manual invocation
- `workflow.suggest()` — proactive matches against current state thresholds
- `workflow.history({ name })` — past run stats

Authoring: drop a markdown playbook at `plugin/playbooks/<name>/playbook.md` and restart the daemon (it boots the registry on start). The frontmatter declares triggers, recall sources, process gates, and output sinks; the body is a Mustache-templated prompt with `{{recall.<source>}}` interpolation. Template vars `{{date}}`, `{{period}}`, `{{project}}`, `{{session_start}}` are pre-expanded in both the body and any `output.kind: file` path.

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
penumbra workflow list
```

Capture: every run writes `workflow.run` / `workflow.recall` / `workflow.outcome` events to `t0_events` and an upserted row to `workflow_stats` (samples / successes / failures / avg_latency_ms / consecutive_failures / quarantined). Three consecutive failures auto-quarantine the workflow — triggers stop firing, `workflow.run` still works manually. Inspect via `penumbra workflow history <name>`.
