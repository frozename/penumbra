# Agent Performance Ledger Backup Design

## Goal

Make `agent_performance` the authoritative source for routing decisions while preserving `docs/superpowers/notes/agent-performance.md` as a generated backup/report that carries the same practical guidance the hand-maintained ledger provided.

## Problem

The current ranking surface is technically live, but its data is thinner than the hand-maintained ledger. `agent_rank` only sees captured rows in `agent_performance`, while `docs/superpowers/notes/agent-performance.md` contains the useful bootstrap signal: rounds, smoke pass, reviewer findings, maestro score, cost estimates, latency, and long notes explaining whether a failure was an agent skill issue, an environment issue, or a prompt issue.

This creates a split-brain routing problem:

- The official feature can say `codex` or `codex-mini` based on recent sparse rows.
- The historic ledger can say `codex-mini` is the established implementer because of many curated outcomes.
- The markdown is still human-editable, so the official feature cannot reliably learn from it.

## Desired State

`agent_performance` becomes the only authoritative ledger. The markdown file becomes a generated artifact and backup:

- Rows are inserted or updated through structured code paths.
- `agent_rank` ranks from `agent_performance` using scoring that matches the hand-maintained ledger.
- `docs/superpowers/notes/agent-performance.md` is regenerated from the DB.
- Operators can still read and diff the markdown, but should not hand-edit row tables.

## Data Model

Keep the existing `agent_performance` table as the core table. Extend behavior around it instead of adding a parallel table.

Required row fields already exist:

- `performance_id`
- `ts`
- `handoff_id`
- `conversation_id`
- `project_id`
- `agent_name`
- `task_type`
- `outcome`
- `rounds`
- `smoke_pass`
- `reviewer_findings`
- `maestro_score`
- `cost_usd`
- `tokens_used`
- `latency_ms`
- `source`
- `notes`
- `metadata_json`

The only schema change needed is outcome expressiveness. The old doc uses `merged`, `merged*`, `merged_with_concerns`, `partial`, `rejected`, `failed`, and `bypassed`. The official enum should support these without collapsing meaningful routing signal:

- `merged_with_concerns`: counts as success for ranking but carries lower smoke/outcome confidence.
- `partial`: counts as failure unless manually enriched as recovered in notes; it remains important signal.
- `bypassed`: neutral, useful for process history but not a positive agent ranking signal.

Rows imported from the old doc use `source='manual_seed'`. New operator-entered rows use `source='operator'`. Reconciler-created rows keep `source='reconciler'`.

## Import

Add an idempotent import command for the existing markdown:

```bash
bun packages/cli/bin/penumbra.ts agent ledger import \
  --from docs/superpowers/notes/agent-performance.md
```

The importer should:

- Parse every markdown table with the canonical ledger header.
- Skip aggregate prose sections.
- Normalize rough values like `~0.05`, `<1`, `n/a`, `merged*`, and `y*`.
- Generate stable `performance_id` values from source path, row timestamp, agent, task type, outcome, and notes hash.
- Store original row annotations in `metadata_json`, including flags such as `manual_recovery`, `estimated_cost`, `estimated_latency`, and `legacy_marker`.
- Be safe to rerun without duplicating rows.

The importer does not need to preserve every formatting quirk. It must preserve the routing signal: task type, agent, outcome, rounds, smoke result, reviewer findings, maestro score, approximate cost, latency, and notes.

## Manual Feed

Add an operator command for the workflow that used to be a markdown edit:

```bash
bun packages/cli/bin/penumbra.ts agent ledger add \
  --handoff-id <id> \
  --task-type implement_substantial \
  --outcome merged \
  --rounds 1 \
  --smoke-pass y \
  --reviewer-findings 0 \
  --maestro-score 5 \
  --cost-usd 0.40 \
  --notes "Clean first-shot implementation; target tests passed."
```

The command should infer what it can from the handoff and usage ledger:

- agent
- conversation id
- project id
- latency
- cost/tokens when available

Explicit flags override inferred values. This preserves the old human judgment loop while removing hand-edited markdown rows.

## Ranking

Update `rankAgents()` so the default score matches the document's scoring model for the supported ranking signal fields. Cost remains part of operator output for visibility, but it is not used in the default score because hardcoded subscription usage does not reliably reflect real marginal cost:

```text
score = 0.32 * outcome_score
      + 0.22 * rounds_score
      + 0.22 * smoke_score
      + 0.16 * reviewer_score
      + 0.08 * maestro_score
```

Use these baseline mappings:

- outcome: `merged`/`pr_opened` = 1, `merged_with_concerns` = 0.85, `partial` = 0.35, `rejected` = 0.2, `failed`/test/typecheck/PR failures = 0, `no_changes`/`bypassed` = neutral.
- rounds: `1 / rounds`, missing = 0.5.
- smoke: `y` = 1, `partial` = 0.5, `n/a` = 0.5, `n` = 0.
- reviewer: `1 - min(findings, 10) / 10`, missing = 0.5.
- maestro: `maestro_score / 5`, missing = 0.5.
- cost: keep `cost_per_success_usd` in output for operator visibility; do not include cost in default ranking score.

Recency should remain visible in output, but not part of the default score. The old doc's purpose is accumulated capability signal, not a recent-only leaderboard. A future `--recency-weight` option can be added if needed.

## Generated Backup

Add a render command:

```bash
bun packages/cli/bin/penumbra.ts agent ledger render \
  --out docs/superpowers/notes/agent-performance.md
```

The generated markdown should include:

- A banner saying the file is generated from `agent_performance`.
- A schema summary.
- Scoring weights.
- A recent rows table grouped by date or source.
- Deterministic aggregate observations per task type.
- A short caveat section explaining that row `notes` carry human routing judgment.

Generated aggregate observations should be simple and deterministic:

- Top candidate per task type by score.
- Agents with at least 5 samples and success rate above a threshold.
- Agents with at least 3 failures or repeated neutral/failure outcomes.
- Sparse-data warnings for candidates with fewer than 3 rows.

Do not try to synthesize free-form prose as if it were hand-written. The generated backup should be stable, readable, and diffable.

## CLI Surface

Extend `penumbra agent` with:

- `rank`: existing command, with scoring parity changes.
- `ledger import --from <markdown>`: one-time bootstrap import.
- `ledger add --handoff-id <id> ...`: operator enrichment path.
- `ledger render --out <path>`: regenerate markdown backup.

No daemon or worker restart should be required for import, add, render, or rank.

## Safety

- Do not store prompt text, response text, raw tool input, or raw tool output in `agent_performance`.
- Keep notes operator-authored and concise.
- Do not let generated markdown overwrite unrelated hand-written notes outside the known file path unless an explicit `--out` is supplied.
- Do not mutate agentchat YAML or auto-route based on ranks in this project.

## Acceptance Criteria

- Importing the existing markdown produces `manual_seed` rows without duplicates on rerun.
- `penumbra agent rank --task-type implement_substantial --include-neutral --min-samples 1` surfaces the same practical conclusion as the hand-maintained ledger: `codex-mini` is the strong scoped-implementation default, with OC-tier/gemini signals represented where their rows support it.
- Adding an operator row updates rank output without editing markdown.
- Rendering regenerates `docs/superpowers/notes/agent-performance.md` from DB data.
- The generated file is stable across two consecutive renders with unchanged data.
- Focused tests and `bun typecheck` pass.
