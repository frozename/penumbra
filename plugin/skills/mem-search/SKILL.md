---
name: mem-search
description: Use when answering "did we already solve this?", "how did we do X last time?", or "what happened in a previous session" — searches penumbra's persistent t2 memory across sessions via the 3-layer search → timeline → fetch workflow.
---

# Memory Search

Search past work across all sessions. Simple workflow: search → timeline → fetch.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

## 3-Layer Workflow (ALWAYS Follow)

**NEVER fetch full details without filtering first. 10x token savings.**

### Step 1: Search — Get Index with IDs

Use the `mcp__penumbra__memory_search` MCP tool:

```
mcp__penumbra__memory_search({ query: "authentication", limit: 20, project: "my-project" })
```

**Returns:** Table with IDs (tier-prefixed), timestamps, types, titles (~50–100 tokens/result).

```
| ID         | Time    | T  | Title                          | Read |
|------------|---------|----|--------------------------------|------|
| t2:11131   | 3:48 PM | 🟣 | Added JWT authentication       | ~75  |
| t2:10942   | 2:15 PM | 🔴 | Fixed auth token expiration    | ~50  |
```

**Parameters:**

- `query` (string) — search term
- `limit` (number) — max results, default 20, max 100
- `project` (string) — project name filter
- `type` (string, optional) — `"observations"`, `"sessions"`, or `"prompts"`
- `obs_type` (string, optional) — comma-separated: `bugfix`, `feature`, `decision`, `discovery`, `change`
- `dateStart` (string, optional) — `YYYY-MM-DD` or epoch ms
- `dateEnd` (string, optional) — `YYYY-MM-DD` or epoch ms
- `offset` (number, optional) — skip N results
- `orderBy` (string, optional) — `"date_desc"` (default), `"date_asc"`, `"relevance"`

### Step 2: Timeline — Get Context Around Interesting Results

Use the `mcp__penumbra__memory_timeline` MCP tool:

```
mcp__penumbra__memory_timeline({ anchor: "t2:11131", depth_before: 3, depth_after: 3, project: "my-project" })
```

Or find the anchor automatically from a query:

```
mcp__penumbra__memory_timeline({ query: "authentication", depth_before: 3, depth_after: 3, project: "my-project" })
```

**Returns:** `depth_before + 1 + depth_after` items in chronological order with observations, sessions, and prompts interleaved around the anchor.

**Parameters:**

- `anchor` (string, optional) — tier-prefixed ID to center around (e.g. `"t2:11131"`)
- `query` (string, optional) — find anchor automatically if `anchor` not provided
- `depth_before` (number, optional) — items before anchor, default 5, max 20
- `depth_after` (number, optional) — items after anchor, default 5, max 20
- `project` (string) — project name filter

### Step 3: Fetch — Get Full Details ONLY for Filtered IDs

Review titles from Step 1 and context from Step 2. Pick relevant IDs. Discard the rest.

Use the `mcp__penumbra__memory_get_observations` MCP tool:

```
mcp__penumbra__memory_get_observations({ ids: ["t2:11131", "t2:10942"] })
```

**ALWAYS use `mcp__penumbra__memory_get_observations` for 2+ observations — single request vs N requests.**

**Parameters:**

- `ids` (array of strings, required) — tier-prefixed observation IDs to fetch
- `orderBy` (string, optional) — `"date_desc"` (default), `"date_asc"`
- `limit` (number, optional) — max observations to return
- `project` (string, optional) — project name filter

**Returns:** Complete observation objects with title, subtitle, narrative, facts, concepts, files (~500–1000 tokens each).

## Examples

**Find recent bug fixes:**

```
mcp__penumbra__memory_search({ query: "bug", type: "observations", obs_type: "bugfix", limit: 20, project: "my-project" })
```

**Find what happened last week:**

```
mcp__penumbra__memory_search({ type: "observations", dateStart: "2026-04-27", limit: 20, project: "my-project" })
```

**Understand context around a discovery:**

```
mcp__penumbra__memory_timeline({ anchor: "t2:11131", depth_before: 5, depth_after: 5, project: "my-project" })
```

**Batch fetch details:**

```
mcp__penumbra__memory_get_observations({ ids: ["t2:11131", "t2:10942", "t2:10855"], orderBy: "date_desc" })
```

## Why This Workflow?

- **Search index:** ~50–100 tokens per result
- **Full observation:** ~500–1000 tokens each
- **Batch fetch:** 1 HTTP request vs N individual requests
- **10x token savings** by filtering before fetching
