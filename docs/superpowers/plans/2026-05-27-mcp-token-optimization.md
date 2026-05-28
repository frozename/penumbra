# MCP Token Optimization — Phased TDD Plan

> Source spec: `docs/superpowers/specs/2026-05-27-mcp-token-optimization.md`
> Plan date: 2026-05-27

## Resolved Open Decisions

1. **Tokenizer for `budgetTokens`**: Character heuristic `Math.ceil(text.length / 4)`. No external tokenizer library — satisfies the "Zod + node built-ins only" constraint; conservative (actual tokens ≤ chars/4 for most English + JSON content).

2. **Handle store persistence**: In-memory `Map<string, HandleEntry>` with process lifetime, TTL eviction via `setTimeout`. No disk serialization. Clients always call `read_handle` within the same server process; disk state adds coordination complexity with no benefit.

3. **Default token limit (`DEFAULT_BUDGET`)**: `8_000` tokens (~32 KB). Based on observed median response sizes; leaves headroom below typical 32 K context windows.

4. **Fields validation**: Strict Zod parse at each tool handler entry point; return MCP error content on failure. Consistent with existing patterns; silent truncation masks client schema bugs.

5. **Deprecation signal**: Emit `_meta.deprecated: true` in the envelope when the old-format response path is still in use. Reuses `extra._meta` forwarding from commit `1930aed1`; no new transport or protocol capability required.

---

## Phase 2 Output — Top-10 Tools by `result_bytes` (populate after Phase 2 executes)

| rank | tool_name | calls | p50_bytes | p95_bytes | total_bytes |
|------|-----------|-------|-----------|-----------|-------------|
| — | _TBD — run task 2.1_ | | | | |

Top-3 targets for Phase 3: _TBD after Phase 2 runs_

---

## Phase 0 — Response Primitives

Dispatch graph: 0.1 ∥ 0.2

### Task 0.1 — Envelope response type

```yaml meta
id: "0.1"
files:
  - packages/mcp/src/responses/envelope.ts
  - packages/mcp/test/responses/envelope.test.ts
file_scope: new
depends_on: []
parallel_with: ["0.2"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Write the test first** (`packages/mcp/test/responses/envelope.test.ts`):

```typescript
import { describe, it, expect } from "bun:test";
import {
  makeEnvelopeResult,
  isEnvelopeResult,
} from "../../src/responses/envelope.js";

describe("makeEnvelopeResult", () => {
  it("embeds content and token_budget in _meta", () => {
    const result = makeEnvelopeResult(
      [{ type: "text", text: "hello" }],
      { usedTokens: 1, limitTokens: 1000, truncated: false, resultBytes: 5 }
    );
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result._meta.token_budget?.used).toBe(1);
    expect(result._meta.token_budget?.limit).toBe(1000);
    expect(result._meta.token_budget?.truncated).toBe(false);
    expect(result._meta.result_bytes).toBe(5);
    expect(result.isEnvelope).toBe(true);
  });
});

describe("isEnvelopeResult", () => {
  it("returns true for an EnvelopeResult", () => {
    const r = makeEnvelopeResult([], {
      usedTokens: 0, limitTokens: 1000, truncated: false,
    });
    expect(isEnvelopeResult(r)).toBe(true);
  });
  it("returns false for a bare content array", () => {
    expect(isEnvelopeResult([{ type: "text", text: "x" }])).toBe(false);
  });
  it("returns false for null", () => {
    expect(isEnvelopeResult(null)).toBe(false);
  });
});
```

**Then implement** (`packages/mcp/src/responses/envelope.ts`):

```typescript
export interface TokenBudget {
  used: number;
  limit: number;
  truncated: boolean;
}

export interface EnvelopeMeta {
  token_budget?: TokenBudget;
  result_bytes?: number;
  handle_id?: string;
  deprecated?: boolean;
}

export type ContentBlock = { type: string; text?: string; [k: string]: unknown };

export interface EnvelopeResult {
  content: ContentBlock[];
  _meta: EnvelopeMeta;
  isEnvelope: true;
}

export interface EnvelopeInput {
  usedTokens: number;
  limitTokens: number;
  truncated: boolean;
  resultBytes?: number;
  handleId?: string;
}

export function makeEnvelopeResult(
  content: ContentBlock[],
  input: EnvelopeInput
): EnvelopeResult {
  return {
    content,
    _meta: {
      token_budget: {
        used: input.usedTokens,
        limit: input.limitTokens,
        truncated: input.truncated,
      },
      ...(input.resultBytes !== undefined && { result_bytes: input.resultBytes }),
      ...(input.handleId !== undefined && { handle_id: input.handleId }),
    },
    isEnvelope: true,
  };
}

export function isEnvelopeResult(v: unknown): v is EnvelopeResult {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as EnvelopeResult).isEnvelope === true
  );
}
```

### Task 0.2 — Budget utilities

```yaml meta
id: "0.2"
files:
  - packages/mcp/src/responses/budget.ts
  - packages/mcp/test/responses/budget.test.ts
file_scope: new
depends_on: []
parallel_with: ["0.1"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Write the test first** (`packages/mcp/test/responses/budget.test.ts`):

```typescript
import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  withinBudget,
  truncateToTokens,
  DEFAULT_BUDGET,
} from "../../src/responses/budget.js";

describe("estimateTokens", () => {
  it("returns ceil(len/4)", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("withinBudget", () => {
  it("returns true when at or under limit", () => {
    expect(withinBudget("a".repeat(400), 100)).toBe(true);
  });
  it("returns false when over limit", () => {
    expect(withinBudget("a".repeat(4001), 1000)).toBe(false);
  });
});

describe("truncateToTokens", () => {
  it("returns unchanged text + truncated=false when within budget", () => {
    const r = truncateToTokens("hello world", 100);
    expect(r.text).toBe("hello world");
    expect(r.truncated).toBe(false);
  });
  it("truncates at charLimit and sets truncated=true", () => {
    const r = truncateToTokens("a".repeat(4000), 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(400);
  });
});

describe("DEFAULT_BUDGET", () => {
  it("is 8000", () => { expect(DEFAULT_BUDGET).toBe(8_000); });
});
```

**Then implement** (`packages/mcp/src/responses/budget.ts`):

```typescript
export const DEFAULT_BUDGET = 8_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function withinBudget(text: string, limitTokens: number): boolean {
  return estimateTokens(text) <= limitTokens;
}

export function truncateToTokens(
  text: string,
  limitTokens: number
): { text: string; truncated: boolean } {
  const charLimit = limitTokens * 4;
  if (text.length <= charLimit) return { text, truncated: false };
  return { text: text.slice(0, charLimit), truncated: true };
}
```

**Integration:** Run `bun test packages/mcp/test/responses/`. Both must pass before Phase 1. Commit: `feat(mcp): response envelope + budget primitives`.

---

## Phase 1 — memory_search Reference Migration

Dispatch graph: 1.1 → 1.2

### Task 1.1 — Failing test for memory_search envelope opt-in

```yaml meta
id: "1.1"
files:
  - packages/mcp/test/tools/memory-search-envelope.test.ts
file_scope: new
depends_on: ["0.1", "0.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

Write this test first — it MUST fail until Task 1.2 is complete:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { handleMemorySearch } from "../../src/tools/registry.js";

const mockSearch = mock(() => {});

describe("memory_search — envelope opt-in", () => {
  beforeEach(() => mockSearch.mockReset());

  it("returns EnvelopeResult with token_budget when envelope=true", async () => {
    mockSearch.mockResolvedValue({ hits: [], total: 0 });
    const result = await handleMemorySearch(
      { query: "test", envelope: true },
      { search: mockSearch }
    );
    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget).toBeDefined();
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
  });

  it("returns bare ContentBlock[] when envelope omitted (backward-compat)", async () => {
    mockSearch.mockResolvedValue({ hits: [], total: 0 });
    const result = await handleMemorySearch(
      { query: "test" },
      { search: mockSearch }
    );
    expect(isEnvelopeResult(result)).toBe(false);
    expect(Array.isArray(result)).toBe(true);
  });
});
```

If `handleMemorySearch` is not yet exported from `registry.ts`, refactor it to be testable before writing the test. Import paths are illustrative — match the actual codebase.

### Task 1.2 — Wire envelope into memory_search

```yaml meta
id: "1.2"
files:
  - packages/mcp/src/tools/registry.ts
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

In `packages/mcp/src/tools/registry.ts`, locate `memory_search`:

1. Add `envelope: z.boolean().optional()` to its Zod input schema.
2. Export `handleMemorySearch(input, deps)` as a standalone testable function.
3. Apply in the return path:

```typescript
import { makeEnvelopeResult, type ContentBlock } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

const rawJson = JSON.stringify(searchResult, null, 2);
const { text, truncated } = truncateToTokens(rawJson, DEFAULT_BUDGET);
const resultBytes = Buffer.byteLength(rawJson, "utf8");
const content: ContentBlock[] = [{ type: "text", text }];

if (input.envelope) {
  return makeEnvelopeResult(content, {
    usedTokens: estimateTokens(text),
    limitTokens: DEFAULT_BUDGET,
    truncated,
    resultBytes,
  });
}
return content;
```

Task 1.1 tests must pass after this. Commit: `feat(mcp): add envelope opt-in to memory_search`.

**Integration:** Run `bun test packages/mcp/test/tools/memory-search-envelope.test.ts`. Pre-existing `test/tools/registry.test.ts` failure is known — do not fix here.

---

## Phase 2 — Measurement

Dispatch graph: 2.1 → 2.2

### Task 2.1 — Run invocation summarizer; capture top-10 by result_bytes

```yaml meta
id: "2.1"
files:
  - packages/mcp/scripts/invocations-summarize.ts
file_scope: extend-shared
depends_on: ["0.1", "0.2"]
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: codex-acp-deep
task_size: small
risk_class: TRIVIAL
```

Measurement-only — no code changes. Run the existing summarizer:

```bash
cd packages/mcp
npx tsx scripts/invocations-summarize.ts 2>&1 | head -200
```

Identify top-10 tools by total `result_bytes` (≥ 24 h window). Pass table to Task 2.2.

### Task 2.2 — Amend plan with Phase 2 output

```yaml meta
id: "2.2"
files:
  - docs/superpowers/plans/2026-05-27-mcp-token-optimization.md
file_scope: modify-existing
depends_on: ["2.1"]
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: codex-acp-deep
task_size: small
risk_class: TRIVIAL
```

Replace the placeholder table in the "Phase 2 Output" section with the actual top-10 from Task 2.1. Replace "Top-3 targets for Phase 3" with the three actual tool names (highest `total_bytes`, excluding `memory_search`). Replace `TOOL_A/B/C` in Phase 3 with those names.

Commit: `docs(plans): Phase 2 measurement output — top-10 tools by result_bytes`.

**Integration:** Re-run validator after amendment; must pass.

---

## Phase 3 — Top-3 Tool Migrations

Dispatch graph: 3.1 ∥ 3.2 ∥ 3.3

> Tool names TBD from Phase 2. `TOOL_A/B/C` are stand-ins — replace after Phase 2.2. Safe to parallelize: each adds a distinct handler block to `registry.ts`.

### Task 3.1 — Migrate TOOL_A

```yaml meta
id: "3.1"
files:
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/TOOL_A-envelope.test.ts
file_scope: modify-existing
depends_on: ["2.2", "1.2"]
parallel_with: ["3.2", "3.3"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

Migration pattern (replace TOOL_A with actual name):

1. Write test: assert `isEnvelopeResult` on `envelope: true`; assert `Array.isArray` on bare call.
2. Add `envelope: z.boolean().optional()` to the tool's Zod schema.
3. Apply `truncateToTokens` + `makeEnvelopeResult` from Task 1.2 pattern.
4. If p95 result > 8 K tokens: also wire `SummaryCache.contentKey(rawJson)` as dedup key.
5. Commit: `feat(mcp): add envelope opt-in to TOOL_A`.

### Task 3.2 — Migrate TOOL_B

```yaml meta
id: "3.2"
files:
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/TOOL_B-envelope.test.ts
file_scope: modify-existing
depends_on: ["2.2", "1.2"]
parallel_with: ["3.1", "3.3"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

Identical to 3.1. Commit: `feat(mcp): add envelope opt-in to TOOL_B`.

### Task 3.3 — Migrate TOOL_C

```yaml meta
id: "3.3"
files:
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/TOOL_C-envelope.test.ts
file_scope: modify-existing
depends_on: ["2.2", "1.2"]
parallel_with: ["3.1", "3.2"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

Identical to 3.1. Commit: `feat(mcp): add envelope opt-in to TOOL_C`.

**Integration:** Run `bun test packages/mcp/test/tools/TOOL_A-envelope.test.ts packages/mcp/test/tools/TOOL_B-envelope.test.ts packages/mcp/test/tools/TOOL_C-envelope.test.ts`. All must pass. One commit per tool.

---

## Phase 4 — Handle Store + read_handle Tool

Dispatch graph: 4.1 → 4.2 → 4.3

### Task 4.1 — Handle store tests

```yaml meta
id: "4.1"
files:
  - packages/mcp/test/handle-store.test.ts
file_scope: new
depends_on: ["0.1", "0.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Write first** (`packages/mcp/test/handle-store.test.ts`):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HandleStore } from "../src/handle-store.js";

describe("HandleStore", () => {
  let store: HandleStore;
  beforeEach(() => { store = new HandleStore({ ttlMs: 80 }); });
  afterEach(() => store.close());

  it("stores and retrieves content by returned id", () => {
    const id = store.put("large content blob");
    expect(store.get(id)).toBe("large content blob");
  });

  it("returns undefined for unknown id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("evicts entries after TTL expires", async () => {
    const id = store.put("evictable");
    await new Promise(r => setTimeout(r, 120));
    expect(store.get(id)).toBeUndefined();
  });

  it("generates unique ids", () => {
    const ids = Array.from({ length: 20 }, () => store.put("x"));
    expect(new Set(ids).size).toBe(20);
  });

  it("keys() returns all live entry ids", () => {
    const id1 = store.put("a");
    const id2 = store.put("b");
    expect(store.keys()).toContain(id1);
    expect(store.keys()).toContain(id2);
  });
});
```

### Task 4.2 — Handle store implementation

```yaml meta
id: "4.2"
files:
  - packages/mcp/src/handle-store.ts
file_scope: new
depends_on: ["4.1"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Implement** (`packages/mcp/src/handle-store.ts`):

```typescript
import { randomUUID } from "crypto";

interface HandleEntry {
  content: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class HandleStore {
  private entries = new Map<string, HandleEntry>();
  private readonly ttlMs: number;

  constructor({ ttlMs = 10 * 60 * 1000 }: { ttlMs?: number } = {}) {
    this.ttlMs = ttlMs;
  }

  put(content: string): string {
    const id = randomUUID();
    const timer = setTimeout(() => this.entries.delete(id), this.ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(id, { content, expiresAt: Date.now() + this.ttlMs, timer });
    return id;
  }

  get(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      clearTimeout(entry.timer);
      this.entries.delete(id);
      return undefined;
    }
    return entry.content;
  }

  keys(): string[] {
    const now = Date.now();
    return Array.from(this.entries.entries())
      .filter(([, e]) => now <= e.expiresAt)
      .map(([k]) => k);
  }

  close(): void {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
  }
}
```

Commit: `feat(mcp): handle store with TTL eviction`.

### Task 4.3 — read_handle MCP tool

```yaml meta
id: "4.3"
files:
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/read-handle.test.ts
file_scope: modify-existing
depends_on: ["4.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Write first** (`packages/mcp/test/tools/read-handle.test.ts`):

```typescript
import { describe, it, expect } from "bun:test";
import { HandleStore } from "../../src/handle-store.js";
import { handleReadHandle } from "../../src/tools/registry.js";

describe("read_handle tool", () => {
  it("returns stored content for a valid handle", async () => {
    const store = new HandleStore();
    const id = store.put(JSON.stringify({ value: 42 }));
    const result = await handleReadHandle({ handle_id: id }, { store });
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain('"value": 42');
    store.close();
  });

  it("returns error message for unknown handle", async () => {
    const store = new HandleStore();
    const result = await handleReadHandle({ handle_id: "bad-id" }, { store });
    expect(result[0].text).toMatch(/not found|expired/i);
    store.close();
  });
});
```

Then add to `registry.ts`:

```typescript
{
  name: "read_handle",
  description: "Retrieve full content for a handle_id returned in a prior tool call's _meta.",
  inputSchema: z.object({
    handle_id: z.string().min(1),
  }),
}

export async function handleReadHandle(
  input: { handle_id: string },
  deps: { store: HandleStore }
): Promise<ContentBlock[]> {
  const content = deps.store.get(input.handle_id);
  if (content === undefined) {
    return [{ type: "text", text: `Handle not found or expired: ${input.handle_id}` }];
  }
  return [{ type: "text", text: content }];
}
```

Wire `HandleStore` singleton into server bootstrap via closure. Do not use a module-level global.

Commit: `feat(mcp): read_handle tool — retrieve stored large results by handle ID`.

**Integration:** Run `bun test packages/mcp/test/handle-store.test.ts packages/mcp/test/tools/read-handle.test.ts`. All must pass.

---

## Phase 5 — Summary Cache

Dispatch graph: 5.1 → 5.2

### Task 5.1 — Summary cache tests

```yaml meta
id: "5.1"
files:
  - packages/mcp/test/summary-cache.test.ts
file_scope: new
depends_on: ["4.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Write first** (`packages/mcp/test/summary-cache.test.ts`):

```typescript
import { describe, it, expect, mock } from "bun:test";
import { SummaryCache } from "../src/summary-cache.js";

describe("SummaryCache", () => {
  it("memoizes: calls compute only once per key", async () => {
    const cache = new SummaryCache({ ttlMs: 60_000 });
    const fn = mock(() => {}).mockResolvedValue("summary");
    await cache.getOrCompute("k", fn);
    await cache.getOrCompute("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    cache.close();
  });

  it("calls compute again for a different key", async () => {
    const cache = new SummaryCache({ ttlMs: 60_000 });
    const fn = mock(() => {}).mockImplementation((k: string) => Promise.resolve(k));
    expect(await cache.getOrCompute("a", () => fn("a"))).toBe("a");
    expect(await cache.getOrCompute("b", () => fn("b"))).toBe("b");
    expect(fn).toHaveBeenCalledTimes(2);
    cache.close();
  });

  it("SummaryCache.contentKey is stable for identical input", () => {
    expect(SummaryCache.contentKey("same")).toBe(SummaryCache.contentKey("same"));
  });

  it("SummaryCache.contentKey differs for different content", () => {
    expect(SummaryCache.contentKey("a")).not.toBe(SummaryCache.contentKey("b"));
  });
});
```

### Task 5.2 — Summary cache implementation

```yaml meta
id: "5.2"
files:
  - packages/mcp/src/summary-cache.ts
file_scope: new
depends_on: ["5.1"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Implement** (`packages/mcp/src/summary-cache.ts`):

```typescript
import { createHash } from "crypto";

interface CacheEntry {
  value: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SummaryCache {
  private entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor({ ttlMs = 30 * 60 * 1000 }: { ttlMs?: number } = {}) {
    this.ttlMs = ttlMs;
  }

  static contentKey(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  }

  async getOrCompute(
    key: string,
    compute: () => Promise<string>
  ): Promise<string> {
    const entry = this.entries.get(key);
    if (entry && Date.now() <= entry.expiresAt) return entry.value;
    if (entry) { clearTimeout(entry.timer); this.entries.delete(key); }
    const value = await compute();
    const timer = setTimeout(() => this.entries.delete(key), this.ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs, timer });
    return value;
  }

  close(): void {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
  }
}
```

Commit: `feat(mcp): summary cache with content-hash dedup`.

**Integration:** Run `bun test packages/mcp/test/summary-cache.test.ts`. Cache wiring into handlers happens in Phase 8.

---

## Phase 6 — MCP Resources Surface

Dispatch graph: 6.1 → 6.2

### Task 6.1 — Resources handler tests

```yaml meta
id: "6.1"
files:
  - packages/mcp/test/resources.test.ts
file_scope: new
depends_on: ["4.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Write first** (`packages/mcp/test/resources.test.ts`):

```typescript
import { describe, it, expect } from "bun:test";
import { buildResourcesHandler } from "../src/resources.js";
import { HandleStore } from "../src/handle-store.js";

describe("MCP resources handler", () => {
  it("lists live handles with mcp://handles/{id} URIs", async () => {
    const store = new HandleStore();
    const id = store.put('{"foo":1}');
    const h = buildResourcesHandler({ store });
    const { resources } = await h.list();
    expect(resources.some(r => r.uri === `mcp://handles/${id}`)).toBe(true);
    expect(resources[0].mimeType).toBe("application/json");
    store.close();
  });

  it("reads resource content by URI", async () => {
    const store = new HandleStore();
    const id = store.put("hello resource");
    const h = buildResourcesHandler({ store });
    const { contents } = await h.read({ uri: `mcp://handles/${id}` });
    expect(contents[0].text).toBe("hello resource");
    store.close();
  });

  it("throws for unknown handle URI", async () => {
    const store = new HandleStore();
    const h = buildResourcesHandler({ store });
    await expect(h.read({ uri: "mcp://handles/nope" })).rejects.toThrow();
    store.close();
  });

  it("throws for unrecognized URI scheme", async () => {
    const store = new HandleStore();
    const h = buildResourcesHandler({ store });
    await expect(h.read({ uri: "file:///etc/passwd" })).rejects.toThrow();
    store.close();
  });
});
```

### Task 6.2 — Resources implementation + server wire-up

```yaml meta
id: "6.2"
files:
  - packages/mcp/src/resources.ts
  - packages/mcp/src/server.ts
file_scope: new
depends_on: ["6.1"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: STANDARD
```

**Implement** (`packages/mcp/src/resources.ts`):

```typescript
import type { HandleStore } from "./handle-store.js";

const HANDLE_URI_PREFIX = "mcp://handles/";

interface Resource { uri: string; name: string; mimeType: string; }
interface ResourceContent { uri: string; text: string; }

export interface ResourcesHandler {
  list: () => Promise<{ resources: Resource[] }>;
  read: (args: { uri: string }) => Promise<{ contents: ResourceContent[] }>;
}

export function buildResourcesHandler({ store }: { store: HandleStore }): ResourcesHandler {
  return {
    async list() {
      return {
        resources: store.keys().map(id => ({
          uri: `${HANDLE_URI_PREFIX}${id}`,
          name: `Handle ${id.slice(0, 8)}…`,
          mimeType: "application/json",
        })),
      };
    },
    async read({ uri }) {
      if (!uri.startsWith(HANDLE_URI_PREFIX)) {
        throw new Error(`Unsupported URI scheme: ${uri}`);
      }
      const id = uri.slice(HANDLE_URI_PREFIX.length);
      const content = store.get(id);
      if (content === undefined) throw new Error(`Handle not found: ${id}`);
      return { contents: [{ uri, text: content }] };
    },
  };
}
```

Register `resources/list` and `resources/read` in `packages/mcp/src/server.ts` (use existing tool registration pattern). Inject the same `HandleStore` instance as `read_handle`.

Commit: `feat(mcp): MCP resources surface — browse and read stored handles`.

**Integration:** Run `bun test packages/mcp/test/resources.test.ts`. Verify via manual `resources/list` call.

---

## Phase 7 — Description Audit Sweep

Dispatch graph: 7.1

### Task 7.1 — Trim token-heavy tool descriptions

```yaml meta
id: "7.1"
files:
  - packages/mcp/src/tools/registry.ts
file_scope: modify-existing
depends_on: ["1.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-fast
task_size: small
risk_class: TRIVIAL
```

Audit every `description` string in `packages/mcp/src/tools/registry.ts`:

1. Trim to ≤ 120 characters.
2. Replace multi-sentence descriptions with a single imperative sentence.
3. Remove embedded examples; drop or move to `examples` array if SDK supports it.
4. Append `"Returns envelope when envelope: true."` to every migrated tool.

Measure before/after:
```bash
npx tsx -e "
import('./src/tools/registry.js').then(m => {
  const tools = m.getTools?.() ?? [];
  tools.forEach(t => console.log(t.name.padEnd(40), t.description?.length ?? 0));
});
"
```

Commit: `docs(mcp): trim tool descriptions — description audit sweep`.

**Integration:** No test gate. Confirm counts ≤ 120. Run `memory_search` to verify no runtime regression.

---

## Phase 8 — Long Tail Migration

Dispatch graph: 8.1 ∥ 8.2

> Instantiate one task per remaining tool from Phase 2 top-10 (positions 4–10). Add 8.3–8.7 as needed.

### Task 8.1 — Migrate remaining tool #4 (template)

```yaml meta
id: "8.1"
files:
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/TOOL_D-envelope.test.ts
file_scope: modify-existing
depends_on: ["3.1", "3.2", "3.3", "5.2"]
parallel_with: ["8.2"]
preferred_agent: codex-acp-spark
fallback_agent: codex-acp-deep
task_size: small
risk_class: STANDARD
```

Same migration pattern as Phase 3. If p95 > 8 K tokens, also wire `SummaryCache`:

```typescript
const cacheKey = SummaryCache.contentKey(rawJson);
const summaryText = await summaryCache.getOrCompute(
  cacheKey,
  () => Promise.resolve(rawJson.slice(0, DEFAULT_BUDGET * 4))
);
```

Commit: `feat(mcp): add envelope opt-in to TOOL_D`.

### Task 8.2 — Migrate remaining tool #5 (template)

```yaml meta
id: "8.2"
files:
  - packages/mcp/src/tools/registry.ts
  - packages/mcp/test/tools/TOOL_E-envelope.test.ts
file_scope: modify-existing
depends_on: ["3.1", "3.2", "3.3", "5.2"]
parallel_with: ["8.1"]
preferred_agent: codex-acp-spark
fallback_agent: codex-acp-deep
task_size: small
risk_class: STANDARD
```

Same migration pattern. Commit: `feat(mcp): add envelope opt-in to TOOL_E`.

**Integration:** Run `bun test packages/mcp/test/tools/` excluding pre-existing failures (`chain-cancel`, `tools/registry`, `tools/brainstorm`). All new `*-envelope.test.ts` files must pass.
