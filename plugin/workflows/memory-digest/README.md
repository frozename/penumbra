# memory-digest workflow

## Purpose

`memory-digest` is a ts-function workflow that injects Maestro t2 memory rows into Claude Code session-start `additionalContext`.

## Trigger

- `lifecycle.session-start`

## Behavior

The workflow composes a markdown section from live maestro-scoped memories in `t2_memories`:

```markdown
# Maestro memory digest (auto-loaded by penumbra)

- [title](slug) — hook
- [title](slug) — hook
  ...
```

Rows are filtered to direct-origin, unretired entries where `slug` and `hook` are set and
`project_id IS NULL`.

The result is emitted through the workflow `session-reminder` sink so `/workflows/trigger` can
append it to `additionalContext`.

## Configuration

`PENUMBRA_MEMORY_DIGEST_MAX_LINES` controls the maximum number of rows in the digest.
If unset, it defaults to `200`.

## Data source

The query is:

```sql
SELECT slug, title, hook
FROM t2_memories
WHERE origin = 'direct'
  AND retired_at IS NULL
  AND slug IS NOT NULL
  AND hook IS NOT NULL
  AND project_id IS NULL
ORDER BY updated_at DESC
LIMIT :limit;
```
