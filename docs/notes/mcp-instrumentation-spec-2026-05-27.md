# MCP instrumentation — adversarial-plan input (2026-05-27 re-fan)

## Workflow guardrails (apply to ALL planner personas)

- **Integration persona MUST return its plan inline in the conversation response. Do NOT write or edit any file in the working tree.** (Prior fan-out at 2026-05-26T16:27:31Z had the integration persona write `docs/plans/2026-05-26-mcp-instrumentation.md` directly, bypassing the workflow contract. Do not repeat.)
- All personas: return plan content as the chain response body. The synthesizer will collate.
- Phased TDD plans only — each phase must have a concrete RED test before code changes.

## Scoping note (the actual content to plan against)

The following is the verbatim scoping note at `docs/notes/mcp-instrumentation-plan-2026-05-26.md`. Plan against this content.

---

# MCP instrumentation plan — measure before optimizing

**Date:** 2026-05-26
**Status:** scoping note, not yet a spec
**Trigger:** observed penumbra MCP surfaces in ~50% more sessions than other servers; ~110 tools exposed; suspected high per-call payload size. Want data before redesigning surfaces.

## Goal

Produce a per-tool table with:
- **calls** — invocations per session and per day
- **bytes_in** — serialized argument size
- **bytes_out** — serialized result size
- **p50/p95 bytes_out** — distribution, not just mean
- **errors** — count + first error sample
- **origin** — who called it (already resolvable via `resolveToolOrigin`)

This is the input to the consolidation spec. Without it we'd be guessing which tools matter.

## Leverage points

All 129 tools register through one path: `packages/mcp/src/server.ts:46-55` iterates `TOOL_REGISTRY` and calls `server.registerTool`. A single wrapper there instruments every tool — no per-tool edits.

Federated tools register separately via `registerFederatedTools` (line 56); the same wrapper pattern needs to apply there.

`resolveToolOrigin` in `packages/mcp/src/tool-origin.ts:13` already extracts origin from request headers / `_meta`. Reuse it.

## What to log per invocation

```jsonl
{
  "ts": "2026-05-26T18:33:00.123Z",
  "tool": "memory_search",
  "origin": "claude-code/maestro",
  "args_bytes": 412,
  "result_bytes": 8421,
  "duration_ms": 87,
  "ok": true,
  "error_kind": null
}
```

One line per call, append-only JSONL. No payloads — bytes only. Keeps the log small and avoids leaking sensitive query text.

**Where to write:** `~/.local/state/penumbra/mcp-invocations.jsonl` (XDG state dir, matches the recent config move to XDG config). Daily rotation, gzip after rotation, keep 14 days.

## Implementation sketch (one phase, ~half-day)

1. Add `packages/mcp/src/instrumentation.ts` exporting `wrapHandler(name, handler)` that:
   - calls the original handler
   - serializes args via `JSON.stringify` for byte count (catch and downgrade on circular refs)
   - serializes result the same way
   - timestamps and appends a line to the JSONL
   - swallows logger errors (never break a tool because logging failed)
2. Edit `server.ts:50-54` — wrap `def.makeHandler(opts.daemon)` before passing to `registerTool`.
3. Edit `registerFederatedTools` to accept and apply the same wrapper.
4. Gate behind `PENUMBRA_MCP_INVOCATION_LOG=1` so it's opt-in and reversible.
5. Add a one-line reader: `bun packages/mcp/scripts/invocations-summarize.ts --since 7d` → prints the per-tool table above.

## Analysis queries (run after 3-7 days of data)

The reader script answers:

- **Top 20 tools by call count.** Identifies the hot path.
- **Top 20 tools by total bytes_out.** Identifies context-bloat offenders.
- **Tools with p95 bytes_out > 8KB.** Candidates for adding `detail: "summary" | "full"`.
- **Tools never called in 7 days.** Candidates for removal.
- **Tools called only from one origin.** Candidates for moving out of the shared registry.
- **Frequently-co-occurring tool pairs** (e.g. `memory_search` → `memory_get_observations`). Candidates for merge into one staged tool.

## Out of scope for this plan

- The actual consolidation spec — that's the follow-up, gated on this data.
- Schema audit (layer 2 from the optimization excerpt — `detail` knobs, cursors, enum tightening). Will be informed by which tools the data flags as high-byte.
- Federation-side optimization. Same instrumentation will surface it; redesign is separate.

## Open questions

- Do we want per-session aggregation in the log line (so a `session_id` field needs threading through)? Current MCP request envelope may or may not carry one — check before committing to it.
- Sampling: at the volume implied by 50% of sessions touching penumbra, do we need sampling? Probably not — JSONL append is cheap, and we want every call for the byte-distribution stats.

## Decision gates before moving past this plan

1. Confirm `PENUMBRA_MCP_INVOCATION_LOG` is the right env-var convention (registry-driven now — should be added to `@penumbra/config` if we want it typed).
2. Decide log location: `~/.local/state/penumbra/` vs `~/.config/penumbra/state/` vs daemon-managed in sqlite. JSONL is simpler; sqlite would let us query without a custom reader. Lean JSONL for now.
3. Pick the next-action threshold: "run for N days, then write consolidation spec" vs "run continuously, write spec when something obvious shows up". Lean the former for forcing function.
