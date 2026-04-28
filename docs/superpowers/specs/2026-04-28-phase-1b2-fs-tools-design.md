# ACP Phase 1b.2 — `fs.glob` and `fs.grep` MCP Tools (Design)

**Status:** design approved 2026-04-28; implementation plan to follow via writing-plans.

**Goal:** let an ACP-dispatched agent investigate code inside its dispatch's worktree by calling two new penumbra-mcp tools — `fs.glob` (filename pattern search) and `fs.grep` (content search) — without inlined plan content. Strictly downstream of Phase 1a (MCP injection); these tools surface to ACP agents through the existing `options.mcpServers: [penumbra-mcp]` opt-in.

**Non-goals:**
- Write access (Phase 1d).
- Per-call permission elicitation (Phase 1c v2).
- Multiline regex, context lines (`-A`/`-B`/`-C`), file-type filters, line-number flags. Defer to a future surface expansion if real usage demands.
- New ACP capabilities. `fs.glob` and `fs.grep` are MCP tools, not ACP `clientCapabilities` (ACP has no native glob/grep — see Phase 1b.1 redesign rationale).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Worktree scope by `handoff_id` arg.** Tool input includes optional `handoff_id`; defaults to `PENUMBRA_HANDOFF_ID` env var. Daemon resolves handoff → worktree path via worktree manager. | Daemon has no ambient "current calling agent". Mirrors `worktree.inspect`'s `/worktrees/<handoff_id>` shape and reuses the existing realpath-relative escape check from Phase 1b.1. |
| 2 | **Thin β API surface.** `fs.glob({pattern, path?, max_results?, include_ignored?, handoff_id?})`. `fs.grep({pattern, path?, glob?, output_mode: 'content' \| 'files_with_matches', case_insensitive?, max_results?, handoff_id?})`. | Covers ~80% of code-investigation queries. Skips multiline regex, context lines, type filter, line-numbers-as-flag — those rarely apply and add edge cases. Can grow to mirror Claude Code's full Grep later if usage demands. |
| 3 | **Hybrid engine.** `fs.glob` uses `Bun.Glob` (zero deps, fast pattern matching). `fs.grep` spawns `rg --json` (battle-tested binary perf where it matters). | `rg` PATH lookup with `PENUMBRA_RG_BINARY` env override; explicit `engine_unavailable` error if missing — no silent JS fallback (perf cliff would surprise the agent mid-investigation). |
| 4 | **No new permission gating in 1b.2.** Inherit Phase 1a's `mcpServers` opt-in: any agent with penumbra-mcp injected gets these tools. Worktree scoping (decision 1) is the security boundary. | Phase 1a already settled the per-agent decision (do you trust this agent with penumbra-mcp?). Phase 1c v2 is the right place for fine-grained per-tool allowlists + handoff.approve gating; anticipating it now duplicates work. |
| 5 | **Soft default + `max_results` override + hard ceiling + `truncated` flag.** Defaults: glob 1000 / grep-content 50 / grep-files 1000. Hard ceilings: 5000 / 500 / 5000. Per-line text capped at 1KB. Response always includes `truncated: boolean`. `.gitignore` honored by default; `include_ignored: true` (both tools) overrides. | Hard caps alone are too tight for legit "find all uses of X" queries; unbounded risks 50k-match greps blowing context. Explicit `truncated` flag prevents the agent from silently treating a partial result as complete. |

## Architecture

Three layers + one upstream wire.

**Layer 1 — MCP tools.** `packages/mcp/src/tools/fs-glob.ts` and `fs-grep.ts`. Thin handlers: validate input, resolve `handoff_id` (arg → `PENUMBRA_HANDOFF_ID` env → error), forward to daemon, return text content. No search logic.

**Layer 2 — Daemon HTTP routes.** `POST /worktrees/:handoff_id/glob` and `POST /worktrees/:handoff_id/grep`. Resolve handoff via worktree manager (404 on unknown/inactive). Resolve search root: if `args.path` absent → root = worktree; else realpath(`args.path`) must be inside worktree (400 `outside_worktree` otherwise). Delegate to fs-search; return JSON.

**Layer 3 — Search module.** `packages/daemon/src/fs-search.ts`. Pure functions:

- `executeGlob({pattern, path?, max_results?, include_ignored?}, worktree) → {results: string[], truncated: boolean}`. Uses `Bun.Glob` with `cwd: worktree` (or resolved sub-path), reads `mtime` for each match via `fs.stat`, sorts descending, applies cap. Honors `.gitignore` by walking up from each match to the worktree root and checking against the union of ignore files (or filters paths post-glob via the `ignore` package — see implementation notes).
- `executeGrep({pattern, path?, glob?, output_mode, case_insensitive?, include_ignored?, max_results?}, worktree) → {results: ..., truncated: boolean}`. Spawns `rg --json` with appropriate flags (`-i` when `case_insensitive`, `-g <glob>` when `glob` set, `--files-with-matches` when `output_mode='files_with_matches'`, `--no-ignore` when `include_ignored=true`). Parses JSONL streaming output. **Client-side global count** (ripgrep's `--max-count` is per-file, not global): stop reading the JSONL stream once `max_results + 1` `match` events have been seen, kill the subprocess, set `truncated = (events_seen > max_results)`. Apply 1KB per-line text cap, return the structured rows.

**Upstream wire.** `packages/agentchat/src/adapters/stdio-acp.ts`: when constructing the `env` for the penumbra-mcp server entry passed via `session/new`'s `mcpServers` (already a Phase 1a code path), inject `PENUMBRA_HANDOFF_ID=<dispatch handoff_id>`. One extra entry in an existing object literal.

**Shared path-validation refactor.** `executeReadTextFile` (Phase 1b.1, in `packages/agentchat/src/adapters/acp-fs.ts`) already implements `resolveInsideWorktree` — realpath both worktree and target, assert `path.relative` doesn't escape. Extract to `packages/core/src/fs-paths.ts` so 1b.1 and 1b.2 share one boundary check. Behavior-preserving for 1b.1; existing tests continue to pass.

## File layout

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/core/src/fs-paths.ts` | `resolveInsideWorktree(userPath, worktree)` extracted from acp-fs.ts. Single source of truth for worktree-boundary realpath check. |
| Modify | `packages/agentchat/src/adapters/acp-fs.ts` | Import `resolveInsideWorktree` from core; remove the local copy. No behavior change. |
| Create | `packages/daemon/src/fs-search.ts` | `executeGlob`, `executeGrep`. |
| Modify | daemon HTTP server (existing routes file) | Two new POST routes scoped to `/worktrees/:handoff_id/{glob,grep}`. |
| Modify | `packages/mcp/src/daemon-client.ts` | `globInWorktree(handoff_id, args)`, `grepInWorktree(handoff_id, args)`. |
| Create | `packages/mcp/src/tools/fs-glob.ts` | Tool handler; env-default for `handoff_id`. |
| Create | `packages/mcp/src/tools/fs-grep.ts` | Same shape. |
| Modify | `packages/mcp/src/server.ts` | Register the two tools. |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Inject `PENUMBRA_HANDOFF_ID` into penumbra-mcp's env entry. |
| Create | `packages/daemon/test/fs-search.test.ts` | Unit tests against `mkdtempSync` tree. |
| Create | `packages/daemon/test/routes-fs.test.ts` | HTTP route tests with daemon in-test. |
| Create | `packages/mcp/test/tools/fs-glob.test.ts` | Handler tests vs mock DaemonClient. |
| Create | `packages/mcp/test/tools/fs-grep.test.ts` | Handler tests vs mock DaemonClient. |
| Create | `packages/core/test/fs-paths.test.ts` | Tests for the extracted `resolveInsideWorktree`. |
| Modify | existing acp-fs.test.ts | Tests still pass through the imported helper; no other change. |
| Modify | existing stdio-acp tests | Verify `PENUMBRA_HANDOFF_ID` is injected into penumbra-mcp env. |

## Data flow

**fs.grep happy path (content mode):**

```
ACP agent (worktree W, handoff H):
  -> tool call: fs.grep({pattern: "TODO", glob: "*.ts", output_mode: "content"})
penumbra-mcp fs-grep handler:
  -> handoff_id arg absent → reads PENUMBRA_HANDOFF_ID=H from env
  -> daemon.grepInWorktree(H, {pattern, glob, output_mode, max_results=50})
daemon POST /worktrees/H/grep:
  -> worktreeManager.get(H) → worktree path W (404 if unknown)
  -> args.path absent → searchRoot = W
  -> executeGrep({pattern, glob, output_mode, max_results}, W)
       -> spawn `rg --json --glob '*.ts' 'TODO' W`
       -> parse JSONL stream; collect up to 51 match events client-side
       -> truncated = (events_seen > 50); kill subprocess once threshold hit
       -> per-row text capped at 1KB (suffix '…' if cut)
  -> respond 200 { results: [{path, line, text}, ...], truncated: false }
penumbra-mcp:
  -> JSON.stringify(response), return as text content
ACP agent: receives results, reasons about them
```

**Error paths:**

| Trigger | Where | Surface |
|---|---|---|
| Unknown/closed handoff | daemon | 404 → tool `{error: {code: 'unknown_handoff'}}`, `isError: true` |
| `path` arg realpath escapes worktree | daemon (via `resolveInsideWorktree`) | 400 → tool `{error: {code: 'outside_worktree'}}`, `isError: true` |
| `rg` not on PATH | `executeGrep` spawn | 500 `{code: 'engine_unavailable', hint: '...'}` → tool surfaces with same code |
| `rg` exits non-zero with stderr (bad regex) | `executeGrep` | 400 `{code: 'bad_pattern', message: <stderr first line>}` → tool surfaces |
| `handoff_id` arg absent and `PENUMBRA_HANDOFF_ID` env unset | MCP tool handler | `{error: {code: 'no_handoff_context', message: 'pass handoff_id explicitly or run inside a dispatch'}}`, `isError: true`. No daemon call. |
| `pattern` empty / missing | MCP tool handler (zod) | Validation error to agent. |
| `max_results` above hard ceiling | MCP tool handler (zod `.max()`) | Validation error to agent. |
| `output_mode` not in `'content' \| 'files_with_matches'` | MCP tool handler (zod) | Validation error. |
| Symlink loop / broken symlink during glob | `Bun.Glob` | Broken symlinks silently skipped (matches `rg` default); loops bounded by Bun.Glob's depth. |
| Empty result set | normal | `{results: [], truncated: false}` — not an error. |
| Concurrent calls during dispatch | benign | Read-only; no locks needed. |

## Error model summary

Tool responses use the existing penumbra-mcp shape: success returns text-content JSON; errors return `{error: {code, message}}` with `isError: true`. Codes are namespaced informally: `unknown_handoff`, `no_handoff_context`, `outside_worktree`, `engine_unavailable`, `bad_pattern`. Validation errors (zod) use the SDK's default surface.

## Testing

Five test layers, ~30 tests total:

1. **`packages/core/test/fs-paths.test.ts`** — port the 4 path-validation cases from existing `acp-fs.test.ts` (inside/outside/relative-escape/symlink-escape) onto the extracted helper. Existing acp-fs tests continue to pass through the new import.
2. **`packages/daemon/test/fs-search.test.ts`** — unit tests against a `mkdtempSync` synthetic tree. Glob: pattern matches, mtime ordering, soft default cap, `max_results` ceiling, `.gitignore` honored, `include_ignored: true` override, escape rejection, broken symlink skipped, empty results. Grep content: basic match, `glob` filter, `case_insensitive`, soft cap + truncated flag, 1KB per-line cap, missing rg → `engine_unavailable` (mocked via `PENUMBRA_RG_BINARY=/no/such/bin`), bad regex → `bad_pattern`. Grep files_with_matches: dedup paths, soft cap, truncated flag.
3. **`packages/daemon/test/routes-fs.test.ts`** — HTTP route tests with daemon in-test. 404 unknown handoff, 400 outside-worktree path, 200 happy path (one glob match, one grep match), auth header required.
4. **`packages/mcp/test/tools/fs-glob.test.ts`, `…/fs-grep.test.ts`** — handler tests vs mock DaemonClient. Arg pass-through, `handoff_id` defaulted from `PENUMBRA_HANDOFF_ID` env, `no_handoff_context` when neither set, daemon HTTP errors surface as `isError: true` with code preserved.
5. **stdio-acp env injection** — extend existing stdio-acp tests to verify the spawned penumbra-mcp's env contains `PENUMBRA_HANDOFF_ID=<dispatch-id>`.

**Maestro-side smoke (post-merge, not implementer scope):** claude-acp-sonnet dispatched with: "use `fs.glob` to find every `*.test.ts` file under `packages/agentchat/test`, then `fs.grep` for `describe(` in those files. Reply with the count of `describe` blocks across all files." Pass criterion: count matches host-side `rg -c 'describe\(' packages/agentchat/test/**/*.test.ts | awk -F: '{s+=$2} END {print s}'`. Append outcome to `docs/superpowers/notes/agent-performance.md`.

## Implementation notes

- **`.gitignore` honoring for glob.** `Bun.Glob` does not natively read `.gitignore`. Two viable approaches: (a) run the glob, then filter results through the `ignore` npm package seeded with the worktree's gitignore stack; (b) walk the worktree manually, respecting `.gitignore` per-directory. (a) is simpler and matches `rg`'s behavior closely enough for code-investigation queries. The `ignore` package is small and battle-tested.
- **`rg --json` output shape.** Lines are JSONL, each `{type, data}` where `type ∈ {begin, match, context, end, summary}`. We only parse `match` events; ignore the rest. Each `match.data` has `path`, `line_number`, `lines.text`, `submatches`. We surface `{path, line, text}` flattened.
- **Spawn safety.** `rg` invoked with `--no-config`, `--with-filename`, args passed via argv (never shell-interpolated). Pattern is a positional arg, never spliced into a shell string — ripgrep handles regex parsing.
- **Per-line truncation timing.** Truncate `text` after `rg` emits it but before serializing to JSON, so we don't ship 5MB of minified-file content.

## Effort estimate

| Task | Effort |
|---|---|
| Extract `resolveInsideWorktree` to core + tests | 30 min |
| `executeGlob` + tests | 1.5 h |
| `executeGrep` + tests | 2 h |
| Daemon HTTP routes + tests | 1 h |
| MCP tool handlers + tests | 1 h |
| stdio-acp env injection + test | 30 min |
| Maestro-side smoke (operator step) | 30 min |

Total implementer scope: ~6–7 hours focused work (1 day with breaks). Aligns with the roadmap's "1–2 days" estimate.

## Open questions deferred to plan

- Exact `.gitignore` filtering library (`ignore` vs hand-rolled) — try `ignore` first, fall back if its semantics diverge.
- Whether to surface `rg`'s reported total-match count in the `truncated` payload (e.g., `{truncated: true, returned: 50, hard_ceiling: 500}`) or keep it boolean. Likely the structured form, finalized in the plan.
- Routes file location — `packages/daemon/src/server.ts` vs a routes module — to be confirmed against the current daemon route layout when writing the plan.

## Composition with later phases

- **Phase 1c v2 (per-tool allowlist + handoff.approve gating):** when it lands, `fs.glob`/`fs.grep` can be added to the per-agent allowed-tools yaml (becomes a coarser gate alongside the existing `mcpServers` opt-in). No code change inside fs-search itself.
- **Phase 1d (write tools):** the same `resolveInsideWorktree` helper extracted here will be used for `write_file`/`edit`. The `PENUMBRA_HANDOFF_ID` env wiring is reused.
- **Phase 3a (`session/update` → t0 events):** fs.glob/fs.grep calls flow through penumbra-mcp → daemon and are already structured; capturing them as t0 events is a daemon-side concern, no fs-search change.
