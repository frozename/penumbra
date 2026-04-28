# Maestro Visual Sugar — Design

**Status:** design-approved 2026-04-28; pending implementation plan.
**Predecessor:** Phase 1d (write tools, ACP-only, shipped 2026-04-28). This is unrelated to the implementation; it's a maestro-tooling enrichment for the Claude Code harness.

## 1. Summary

Two thin layers of visual sugar over the maestro's existing penumbra MCP workflow:

- **Inline tool-result rendering.** Every penumbra MCP tool that returns a structured payload prepends a one-line summary header (rendered with a single penumbra-themed glyph + dim-gray ANSI for IDs and worker names) to its text content, with the raw JSON retained verbatim below. The maestro reads JSON; the user reads the header.
- **Persistent statusline.** A new `penumbra statusline` CLI subcommand returns a single line summarizing in-flight dispatches and pending permissions; wired into Claude Code via `~/.claude/settings.json`'s `statusLine` config. 2-second file cache absorbs Claude Code's ~2-5s refresh cadence without hammering the daemon.

Notifications (the third candidate from brainstorm) are explicitly **out of scope** — deferred. The user's existing Notchi/OpenIsland integrations cover sound/toast on a coarser granularity already.

## 2. Motivation

The maestro pattern from Phase 1c v2 + Phase 1d settled around a workflow where the user observes me orchestrating long-running dispatches in Claude Code. Today that observation is information-dense:

- Tool results are JSON blobs in expanders. To know "what just happened" requires expanding and reading.
- In-flight dispatch status requires me polling and surfacing — there's no glance-able state visible to the user.

Visual sugar reduces the perceived overhead of long orchestration sessions. Lower-friction observation makes the maestro pattern more sustainable for multi-hour Phase work.

## 3. Locked design decisions

| ID | Decision | Rationale |
|---|---|---|
| **A** | Inline rendering via tool-response text formatting (header + JSON in same text content block) | Touches every penumbra MCP tool handler but no harness config. Pure server-side change |
| **B** | Persistent statusline via CLI subcommand + `~/.claude/settings.json` config | Standard Claude Code statusline mechanism; 2s file cache to absorb refresh cadence |
| **C — DROPPED** | Desktop notifications via PostToolUse hook | Notchi/OpenIsland already cover at coarser granularity; defer if user requests |
| **Glyph palette** | `◌` in-flight, `◐` awaiting decision (action needed), `●` terminal/done, `◑` failed/rejected | Half-disc shapes echo the penumbra name; carry status semantics in one character |
| **Color** | ANSI dim (`\x1b[2m`) for IDs and worker names; status word in default color | Eye lands on the status word; `NO_COLOR=1` disables. No theming knobs. |
| **Statusline location** | Machine-local `~/.claude/settings.json` | User is the only operator; project-level pollutes other devs' settings |
| **Statusline cache** | 2s file-based cache at `/tmp/penumbra-statusline.cache` | Claude Code refreshes statusline at its own cadence; 2s cache cleanly absorbs that |

## 4. Architecture

```
                ┌──────────────────────────────────────────────────────────┐
                │  Maestro session in Claude Code                          │
                │                                                           │
                │  ┌─────────────────────────────────────────────────┐     │
                │  │  Inline tool result (Part A)                     │     │
                │  │  ◌ chain_status  h-7d3a91  dispatched  3m12s    │     │
                │  │                                                  │     │
                │  │  { "handoff_id": "7d3a91…", "status": …, … }     │     │
                │  └─────────────────────────────────────────────────┘     │
                │                                                           │
                │  ┌─────────────────────────────────────────────────┐     │
                │  │  Statusline (Part B; ~2-5s refresh)              │     │
                │  │  ◐ penumbra  1 awaiting  3 dispatched  12 done   │     │
                │  └─────────────────────────────────────────────────┘     │
                └──────────────────────────────────────────────────────────┘
                                        │
                ┌───────────────────────┼─────────────────────────────────┐
                │                       │                                  │
        ┌───────▼──────────┐    ┌───────▼──────────┐                       │
        │ penumbra-mcp     │    │ statusline CLI   │                       │
        │ tool handlers    │    │ + 2s file cache  │                       │
        │ now return text  │    │ at /tmp/         │                       │
        │ {summary\n\njson}│    └───────┬──────────┘                       │
        └───────┬──────────┘            │                                  │
                │                       │ HTTP                             │
                └───────────────────────┴──────────────────────────────────┘
                                        │
                                  ┌─────▼──────┐
                                  │  daemon    │  (existing routes; no
                                  │  (existing)│   new routes needed)
                                  └────────────┘
```

Two thin shims; both consume the daemon's existing read-side HTTP. No new daemon work, no new persistent state, no harness hooks beyond the one-line `statusLine` config addition.

## 5. Components

| File | Responsibility | New / modified |
|---|---|---|
| `packages/mcp/src/format-summary.ts` | Pure-function formatter helpers per tool: `formatChainStart`, `formatChainStatus`, `formatChainWait`, `formatChainGetResponse`, `formatHandoffGet`, `formatHandoffListPending`, `formatPermissionListPending`, `formatPermissionApprove`. Plus shared utils: `dimColor(s)`, `truncateId(s, n)`, `formatElapsed(ms)`, `glyphFor(status)`. Honors `NO_COLOR` env. | NEW |
| `packages/mcp/src/tools/{chain-start,chain-status,chain-wait,chain-get-response,handoff-get,handoff-list,permission-list-pending,permission-approve}.ts` | Each handler post-processes its result via the matching formatter. Returns text content `${summary}\n\n${JSON.stringify(payload, null, 2)}` | MODIFIED ×8 |
| `packages/cli/src/commands/statusline.ts` | `penumbra statusline` subcommand. Reads `/tmp/penumbra-statusline.cache` if `<2s old`; else fetches daemon counts, formats the line, writes the cache, prints. Falls back gracefully when daemon offline. | NEW |
| `packages/cli/bin/penumbra.ts` | Register the `statusline` subcommand in the CLI dispatcher. | MODIFIED |
| `packages/mcp/test/format-summary.test.ts` | Pure-function tests for the formatters (~12). | NEW |
| `packages/mcp/test/tools/<each>.test.ts` | Existing handler tests gain assertions on the new summary header. | MODIFIED ×8 |
| `packages/cli/test/statusline.test.ts` | CLI subcommand tests: cache hit, cache miss, daemon-down fallback, glyph priority logic, count formatting (~5). | NEW |
| `~/.claude/settings.json` | Add `"statusLine": { "type": "command", "command": "PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live bun /Volumes/WorkSSD/repos/personal/penumbra/packages/cli/bin/penumbra.ts statusline" }`. Machine-local; not committed. | MODIFIED (machine-local) |

Total: 2 new TS source files + 1 new test file (`format-summary.test.ts`) + 1 new test file (`statusline.test.ts`) + 8 modified handlers + 8 lightly-touched existing test files + a 1-line settings.json edit.

## 6. Inline rendering format reference (per-tool)

ID truncation: `h-{first8}…` (e.g. `h-7d3a91ab…`). Permission IDs: `{first6}…`. Worker IDs: `worker-{primary|b|c|d}` (full name; short).

Status-glyph map:
- `dispatched` → `◌`
- `pending` (a permission row awaiting decision) → `◐`
- `completed` → `●`
- `approved` → `●`
- `failed` → `◑`
- `rejected` → `◑`
- `cancelled` → `◑`
- `expired` → `◑`

Color: dim (`\x1b[2m...\x1b[0m`) wraps any ID, worker name, or "config" / "all" trust-mode tag. Status words, tool names, and the leading glyph all render in default color (no color applied to the glyph — the symbol shape is the signal).

Per-tool header templates (the literal strings; `<x>` denotes a runtime-substituted field):

```
chain_start             ◌ chain_start  <agent>  <h-id>  trust=<mode>
chain_status            <glyph> chain_status  <h-id>  <status> on <worker>  <elapsed>
chain_wait              <glyph> chain_wait  <h-id>  <final_status> in <elapsed>
chain_get_response      ● chain_get_response  <agent>  <n> response<s>
handoff_get             <glyph> handoff  <h-id>  <agent>  <status>
handoff_list_pending    ◌ handoff_list_pending  <n> entries  <worker_summary>
permission_list_pending ◐ permission_list_pending  <n> pending  oldest <elapsed>
permission_approve      <glyph> permission  <p-id>  <decision>  remember=<scope>
```

Where:
- `<elapsed>` = humanized: `3m12s`, `47s`, `2h 14m`, `1d 4h`
- `<worker_summary>` = comma-separated `worker-x:n` pairs, e.g. `worker-primary:1, worker-b:2`
- `<final_status>` = `completed` / `failed` / `cancelled` (whatever chain_wait sees)
- `<n> response<s>` = pluralization: `1 response`, `2 responses`

If a payload has zero entries (`permission_list_pending` with no rows), the header reads `● permission_list_pending  no pending`.

## 7. Statusline format reference

The CLI subcommand formats one of these patterns:

```
● penumbra  idle
◌ penumbra  <n> dispatched  <m> done
◐ penumbra  <p> awaiting  <n> dispatched  <m> done
◑ penumbra  daemon offline
```

Glyph priority (highest wins):
1. **`◑`** — daemon HTTP failed (offline, port mismatch, etc.). Counts omitted.
2. **`◐`** — at least one pending permission_request. Surfaces awaiting count first.
3. **`◌`** — at least one dispatched handoff. No pending permissions.
4. **`●`** — neither in-flight nor pending. Counts shown if recent activity (< 1h ago); otherwise just `idle`.

Counts:
- `<n> dispatched`: handoffs with status=`dispatched` right now.
- `<p> awaiting`: permission_requests with status=`pending` right now.
- `<m> done`: handoffs with status=`completed` in the last hour, scoped to the current session if the daemon exposes that (else last hour absolute).

Color: `penumbra` itself rendered dim; counts in default color. Glyph in default color; symbol carries enough information.

**Cache file format** (`/tmp/penumbra-statusline.cache`):

```json
{
  "ts": 1735409832123,        // ms since epoch
  "line": "◐ penumbra  1 awaiting  3 dispatched  12 done"
}
```

If `Date.now() - ts < 2000`, return cached `line`. Else refetch.

## 8. Failure modes

| Condition | Behavior |
|---|---|
| Daemon offline (HTTP error / connection refused) | Statusline returns `◑ penumbra  daemon offline`; no error to stderr (would clutter Claude Code) |
| Daemon slow (> 1.5s response) | Statusline timeouts at 1.5s, returns `◐ penumbra  daemon slow` (or last cached value if available); cache entry retained |
| Cache file corrupt JSON | Treat as cache miss; refetch; overwrite |
| `NO_COLOR=1` set | All ANSI escapes omitted from inline rendering AND statusline |
| Tool handler error during formatting | Formatter wraps in try/catch; on error, fall back to JSON-only response (current behavior). Header generation never breaks the tool |

Last point is critical: a bad formatter can never lose the tool's actual data. Always render the JSON; the header is sugar.

## 9. Testing

### 9.1 Format helpers (`packages/mcp/test/format-summary.test.ts`, ~12 tests)

- One golden-string assertion per `format<X>` helper.
- ID truncation (8-char prefix for handoff_id; 6-char for permission_id).
- Elapsed-time formatting (covers `47s`, `3m12s`, `2h 14m`, `1d 4h`).
- Glyph selection by status (each map entry).
- Pluralization (`1 response` vs `2 responses`).
- Empty-list rendering (`permission_list_pending` with 0 rows).
- `NO_COLOR=1` strips ANSI; otherwise present.

### 9.2 Statusline CLI (`packages/cli/test/statusline.test.ts`, ~5 tests)

- Cache hit (recent file) returns cached line without HTTP.
- Cache miss writes cache after fetch.
- Daemon offline: `◑ penumbra  daemon offline`, no throw.
- Glyph priority: pending permissions wins over dispatched handoffs.
- Counts formatted correctly (zero-suppression, no negative ints).

### 9.3 Existing tool tests (modified ×8)

Each existing handler test gains one assertion: `expect(result.content[0].text).toContain('◌ chain_status') // or appropriate glyph+name pair`. Doesn't enforce the full header — flexibility for the formatter to evolve — just asserts the new format applied.

Total: ~17 new + 8 modified test cases. Suite still runs in seconds.

## 10. Out of scope

- **Notifications** (Notchi / OpenIsland integration). Deferred per user choice; existing Notchi/OpenIsland already cover at coarser granularity. Could be added as a small Phase later (~half day) if desired.
- **Slash commands** for dashboards (`/penumbra-status`). Not necessary given the persistent statusline.
- **Statusline color themes** beyond the dim/normal pair. Single aesthetic; no theming knobs.
- **Per-tool customization** of the inline header (e.g., suppress for some tools but not others). Single rendering policy across all 8 enriched tools.
- **Time-zone-aware elapsed display.** All times relative ("3m12s ago"); never absolute timestamps.
- **Localization.** English-only.
- **Retroactive enrichment of past tool calls.** Only NEW calls render with the new format; the existing transcript stays as-is.

## 11. References

- Existing penumbra MCP tools: `packages/mcp/src/tools/`
- Existing daemon HTTP routes: `packages/daemon/src/routes/`
- Existing PostToolUse hook: `~/.claude/settings.json` → `penumbra hook claude-code` (already wired)
- Notchi / OpenIsland (existing notification integrations) — referenced but not modified
