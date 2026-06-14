# MCP token optimization — response envelopes, projection, handles, budgeter

**Date:** 2026-05-27
**Status:** spec
**Author:** user proposal + maestro survey
**Related:** Phase 6 invocation summarizer (`abff17df`), `2026-05-27-mcp-instrumentation.md`

## Problem

Penumbra's MCP tool surface has **129 tool files, ~113 with input schemas, only 24 with any limit/cursor/detail/truncate knob**. The remaining ~89 tools have no output budgeting. Every call returns full payloads regardless of caller need.

Concrete observation from Phase 7 smoke test (`abff17df`): a single `task_list` call returned **94,621 bytes** with no projection or pagination. `memory_search` returns full t1/t2 memory bodies inline. `handoff_get` returns the full message history. Multiply across an agent session and per-call token cost dominates.

The newly-landed Phase 6 summarizer (`packages/mcp/scripts/invocations-summarize.ts`) can rank tools by actual `result_bytes` from real traffic — providing the data gate for choosing where the wins are.

## Goals

Adopt a standard set of patterns across the tool surface so callers can control payload size predictably:

1. **Detail levels** — every read tool accepts `detail: "exists" | "ids" | "summary" | "compact" | "full"` (default `summary`, never `full`).
2. **Field projection** — every read tool accepts `fields: string[]` for explicit selection.
3. **Caps** — every list tool has hard upper bounds on `limit` (≤20), `maxChars` (≤6000), `maxDepth` (≤2). Server-enforced.
4. **Response envelope** — every tool returns `{ ok, data, summary, cursor, omitted, next }` with `summary` being a 1-sentence prose hint and `next` listing concrete follow-up tool calls.
5. **Compact errors** — replace stack traces with `{ error: <CODE>, message, retry? }` shape.
6. **Handles** — bulky payloads return a `handle` ID; caller invokes `read_handle({ handle, detail, fields })` to fetch what they want.
7. **Server-side summary cache** — for stable resources, cache `summary_200`, `summary_1000`, `tokens_estimate` so the model doesn't re-summarize.
8. **MCP resources for bulky docs** — move documentation/static content out of tools into the MCP resource surface.
9. **Token budgeter** — `budgetTokens?: number` arg on context-heavy tools; server returns ≤ budget.
10. **Compact tool descriptions** — audit + tighten every description to one sentence + canonical follow-up pointer.

## Non-goals

- Breaking changes to existing tool schemas without a deprecation window.
- A full client-side tokenizer (use char/4 estimate; tiktoken adoption is a separate spec if needed).
- Cross-server (federation) handle store. Handles are per-MCP-process; federation forwards the handle ID as opaque.

## Design

### Shared primitives (foundational layer)

Two new modules in `packages/mcp/src/responses/`:

#### `packages/mcp/src/responses/envelope.ts`

```ts
export interface ResponseEnvelope<T> {
  ok: boolean;
  data?: T;
  summary?: string; // 1 sentence max, plain prose
  cursor?: string | null;
  omitted?: { count: number; reason: string };
  next?: Array<{ tool: string; args: Record<string, unknown> }>;
  error?: {
    code: string;
    message: string;
    retry?: { tool: string; args: Record<string, unknown> };
  };
}

export function ok<T>(
  data: T,
  opts?: {
    summary?: string;
    cursor?: string | null;
    omitted?: ResponseEnvelope<T>["omitted"];
    next?: ResponseEnvelope<T>["next"];
  },
): ResponseEnvelope<T>;
export function err(
  code: string,
  message: string,
  retry?: ResponseEnvelope<unknown>["error"]["retry"],
): ResponseEnvelope<never>;
```

Backwards-compat: existing tools wrap their current output as `data` inside `ok(...)`. Callers that don't read the envelope keep working until migrated.

#### `packages/mcp/src/responses/budget.ts`

```ts
import { z } from "zod";

export const BUDGET_INPUT_SHAPE = {
  detail: z.enum(["exists", "ids", "summary", "compact", "full"]).default("summary"),
  fields: z.array(z.string()).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  cursor: z.string().optional(),
  maxChars: z.number().int().min(100).max(6000).optional(),
  budgetTokens: z.number().int().min(50).max(20000).optional(),
};

export function projectFields<T extends Record<string, unknown>>(
  row: T,
  fields?: string[],
): Partial<T>;
export function applyCharBudget<T>(
  rows: T[],
  maxChars: number,
  serialize: (r: T) => string,
): { kept: T[]; omitted: number };
export function estimateTokens(text: string): number; // char / 4 rough estimate, documented
```

### Reference adoption: `memory_search`

Refactor `packages/mcp/src/tools/memory-search.ts` to:

- Use `BUDGET_INPUT_SHAPE` (replaces existing `limit`).
- Add `detail` levels:
  - `exists`: returns `{ ok: true, data: { found: 18 } }` — no rows
  - `ids`: returns `{ ok: true, data: { ids: ["m_1", "m_2", ...] } }`
  - `summary` (default): returns 1-line snippet per hit, ≤140 chars
  - `compact`: title + snippet + score
  - `full`: current behavior (full body)
- Honor `fields` projection on the row shape
- Honor `maxChars` and `budgetTokens`
- Return envelope shape with `summary` ("18 hits, top score 0.84") and `next: [{ tool: "memory_get_observations", args: { id: "<top-id>" } }]`

### Handle store (Phase 2)

`packages/mcp/src/handles/store.ts`: in-memory Map keyed by short ULID-style ID (e.g. `ctx_8f21`), TTL 15min, LRU eviction at 64 entries, total memory cap 2MiB. Entries are `{ id, kind, summary, payload, created_at, last_accessed_at }`. Process-local — federation forwards the ID as opaque, the daemon-side handler resolves it.

New tool `read_handle({ handle, detail, fields, maxChars })`: looks up the handle, applies projection/budget to its payload, returns envelope.

Tools that produce >4KB result payloads get a `--bulk` mode: instead of returning data inline, they store it in the handle store and return `{ handle, summary, next: [{ tool: "read_handle", args: { handle, detail: "compact" } }] }`.

### Server-side summary cache (Phase 3)

For tools backed by stable corpus (memory, plans, specs, notes), pre-compute and cache `summary_200`, `summary_1000`, `tokens_estimate` per row. Cache layer: a small `summary_cache` table keyed by `(table, row_id, content_hash)`. Invalidation: on row update via existing write paths.

### MCP resources (Phase 4)

Register large static docs (`docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md`) as MCP resources via `server.registerResource()`. The MCP SDK's resource surface lets clients fetch by URI without consuming tool-description budget.

### Description audit (Phase 5)

Sweep all 113 tool descriptions. Target one sentence + canonical follow-up pointer. Example diff:

```
- "Search the persistent memory store across t1 and t2 tiers, returning matching observations with full body, metadata, and score for each hit."
+ "Search memory; returns IDs+snippets. Use memory_get_observations for full content."
```

## Constraints

- **Backward compatibility for one minor version.** Old fields stay until next major. Add new fields, default new behaviors to compact, never change response shape without an envelope flag.
- **No new package deps.** `zod` (existing), node built-ins.
- **Per-tool migration is one commit per tool.** Easier to revert one tool if a downstream caller breaks.
- **Federation forwards envelopes verbatim.** No double-wrapping; envelope already at the top level.

## Phases (preview — write-plan will detail)

- **Phase 0** — Response envelope + budget shape primitives in `packages/mcp/src/responses/`. Tests.
- **Phase 1** — Migrate `memory_search` end-to-end as the reference. Tests.
- **Phase 2** — Rank top-10 tools by actual `result_bytes` from Phase 6 summarizer over 24h of real traffic. Document the targets.
- **Phase 3** — Migrate top-3 tools (likely `task_list`, `chain_get_messages`, `handoff_get` based on smoke evidence) one per commit.
- **Phase 4** — Handle store + `read_handle` tool. Migrate top-3 bulk-producing tools to handle mode.
- **Phase 5** — Summary cache for memory + plan/spec corpus.
- **Phase 6** — Resource surface registration for docs.
- **Phase 7** — Description audit sweep (mechanical, dispatchable).
- **Phase 8** — Long tail: remaining tools migrated incrementally, gated on bytes from summarizer.

## Open decisions for plan refinement

- **Tokenizer for `budgetTokens`**: char/4 estimate vs tiktoken (would add a dep). Spec says no new deps; defer tiktoken.
- **Handle store persistence**: in-memory only (lost on restart) vs sqlite-backed. Simplicity says in-memory; concurrent agent sessions say sqlite.
- **Default `limit`**: 10 vs 20. Spec says max 20; default could be lower (5? 10?).
- **`fields` validation**: per-tool whitelist (strict, more typing) vs free-form string array (flexible, callers can mistype).
- **Deprecation signal**: how do we tell clients "this old field will go away" — via the envelope's `next` array? A separate `deprecations: string[]` field? `console.warn` in dev mode?

## Success metrics

- Top-10 tools reduce median `result_bytes` by ≥60% vs pre-Phase-1 baseline (measured via Phase 6 summarizer).
- Tool description token cost (sum of all descriptions in `tools/list` response) reduces by ≥40% after Phase 7.
- No regression in tool functional correctness (existing tests pass).
- New tool calls have a documented `next` action ≥80% of the time (auditable via JSONL inspection).
