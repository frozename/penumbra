# Tooling Knowledge Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate per-repo `AGENTS.md` (canonical) + `CLAUDE.md` / `GEMINI.md` / `JULES.md` (thin pointers) across penumbra, llamactl, sirius-gateway, embersynth; centralize cross-agent reference docs (`agent-fleet.md`, `dispatch-examples.md`, `openai-compat-keys.md`) and a runnable bench harness (`bench.ts`) inside penumbra; wire penumbra-mcp / llamactl-mcp / sirius-mcp into Claude Code, Gemini CLI, and Codex CLI user-level configs.

**Architecture:** Five waves. Wave A discovers MCP bin entrypoints and confirms embersynth-mcp existence. Wave B authors penumbra's content (the bench harness, the 3 cross-agent doc files, penumbra `AGENTS.md`, all 4 sets of pointer files for penumbra). Wave C dispatches per-repo `AGENTS.md` drafts to specific fleet agents and reviews/edits/commits them. Wave D updates the 3 harness configs. Wave E is manual smoke verification.

**Tech Stack:** Bun + TypeScript (bench.ts), Markdown (docs / AGENTS.md / pointers), JSON / TOML (harness configs), `agentchat new --auto --attach` (fleet drafts).

**Spec:** `docs/superpowers/specs/2026-04-26-tooling-knowledge-distribution-design.md`

**Repos in play:**
- `/Volumes/WorkSSD/repos/personal/penumbra` (most work; canonical cross-agent docs)
- `/Volumes/WorkSSD/repos/personal/llamactl`
- `/Volumes/WorkSSD/repos/personal/sirius-gateway`
- `/Volumes/WorkSSD/repos/personal/embersynth`

**User-level configs touched (not in any git repo):**
- `~/.claude/settings.json`
- `~/.gemini/settings.json`
- `~/.codex/config.toml`

**Constraints (every task):**
- Conventional commits, no AI / agent attribution in commit messages.
- TDD where there's executable code (`bench.ts`); for markdown/config tasks, use a structural checklist.
- Bun ONNX teardown panic at end of `bun test` is cosmetic; judge by pass/fail count.

---

## Wave A — Recon (must complete before Wave D)

### Task 1: Confirm MCP bin entrypoints + embersynth-mcp existence

**Files:** none (reconnaissance only — outputs go into the implementation as concrete paths in Wave D config edits)

- [ ] **Step 1.1: Check llamactl-mcp bin**

```bash
ls /Volumes/WorkSSD/repos/personal/llamactl/packages/mcp/
cat /Volumes/WorkSSD/repos/personal/llamactl/packages/mcp/package.json | grep -A 3 '"bin"'
```

Expected output: a `bin/` field in package.json, OR a `src/index.ts` that's the MCP entrypoint. Record the absolute path to the bin file (e.g. `/Volumes/WorkSSD/repos/personal/llamactl/packages/mcp/src/index.ts`). Note the launch command (likely `bun <path>`).

- [ ] **Step 1.2: Check sirius-mcp bin**

```bash
ls /Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-mcp/
cat /Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-mcp/package.json | grep -A 3 '"bin"\|"main"\|"start"'
```

Expected: a bin/main field or a `start` script. Record the launch command.

- [ ] **Step 1.3: Check embersynth-mcp existence**

```bash
ls /Volumes/WorkSSD/repos/personal/embersynth/
ls /Volumes/WorkSSD/repos/personal/embersynth/src 2>/dev/null
grep -rln "@modelcontextprotocol/sdk\|mcp.*server\|McpServer" /Volumes/WorkSSD/repos/personal/embersynth/src 2>/dev/null | head -3
```

Expected: a definitive yes/no on whether embersynth has an MCP server. If yes, find the bin entry. If no, mark embersynth-mcp as deferred and note in Task 16 to open a follow-up issue.

- [ ] **Step 1.4: Document recon outputs**

Append the 3 launch commands (or "DEFERRED: embersynth has no MCP server") into a scratch file at `/tmp/penumbra-dispatch/mcp-recon.txt`. Wave D's tasks reference this file.

```
penumbra: bun /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts (env: PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live)
llamactl: <recorded in step 1.1>
sirius:   <recorded in step 1.2>
embersynth: <yes with launch command, OR DEFERRED>
```

- [ ] **Step 1.5: Verify each MCP server actually starts**

For each non-deferred server, launch it briefly and confirm it speaks MCP over stdio. Penumbra's daemon must be running first; check `cat /tmp/penumbra-live/port` returns a number — if not, run `bun /Volumes/WorkSSD/repos/personal/penumbra/packages/cli/bin/penumbra.ts start --detach`.

```bash
# Penumbra MCP — should print "ready" or similar within 2s
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live timeout 2 bun /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts < /dev/null 2>&1 | head -5

# llamactl MCP — depends on llamactl agent (`local`) being up
timeout 2 <recorded llamactl launch command> < /dev/null 2>&1 | head -5

# sirius MCP
timeout 2 <recorded sirius launch command> < /dev/null 2>&1 | head -5
```

Expected for all: process starts cleanly (no immediate error). It's fine if it hangs waiting on stdin — `timeout 2` will kill it. Record any prereq daemon dependency in `/tmp/penumbra-dispatch/mcp-recon.txt`.

---

## Wave B — Penumbra authoring (single-pass, hand-written)

### Task 2: Extract bench-2 prompts into a constants module

**Files:**
- Create: `packages/agentchat/scripts/bench-prompts.ts`

This isolates the 5 bench prompts so `bench.ts` and any future tooling can reuse them without a copy.

- [ ] **Step 2.1: Create the constants file**

```bash
mkdir -p /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/scripts
```

Then write the file:

```ts
// packages/agentchat/scripts/bench-prompts.ts
/**
 * The 5 bench-2 tasks used to calibrate local + cloud LLMs against our task
 * profile. Each task pairs an attached fixture file with a question and an
 * expected answer.
 *
 * The fixtures must exist at the documented paths in the penumbra repo —
 * bench.ts reads them at runtime so a calibration run always reflects the
 * current state of the code.
 */

export interface BenchTask {
  id: 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
  description: string;
  fixturePath: string;       // path relative to repo root
  fixtureLabel: string;      // shown in the user-message header
  question: string;
  maxTokens: number;
  groundTruth: string;       // for human comparison; bench.ts records both side-by-side
}

const REPO_ROOT_FROM_SCRIPTS = '../../../..';

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'T4',
    description: 'long-context retrieval',
    fixturePath: `${REPO_ROOT_FROM_SCRIPTS}/packages/agentchat/README.md`,
    fixtureLabel: 'README.md',
    question:
      'What is the default value of the --concurrency flag for agentchat-worker according to this README? Output only a single integer.',
    maxTokens: 8,
    groundTruth: '4 (inferred from the example command line — README does not state default explicitly)',
  },
  {
    id: 'T5',
    description: 'multi-step reasoning',
    fixturePath: `${REPO_ROOT_FROM_SCRIPTS}/packages/agentchat/src/worker/dispatcher.ts`,
    fixtureLabel: 'dispatcher.ts',
    question:
      'If deps.concurrency is 4 and four handoffs are currently in-flight, what happens to the 5th handle() call if it is for a NEW conversation_id? Answer in exactly 2 sentences. Mention which lock or queue applies.',
    maxTokens: 100,
    groundTruth:
      'The 5th call acquires the conv lock for the new id (no existing holder) but blocks in the global semaphoreWaiters queue because concurrency is exhausted. It proceeds when one in-flight task releases the semaphore.',
  },
  {
    id: 'T6',
    description: 'format under tension (no bugs)',
    fixturePath: `${REPO_ROOT_FROM_SCRIPTS}/packages/agentchat/src/cli/attachments.ts`,
    fixtureLabel: 'attachments.ts',
    question:
      'Find any actual logical bugs in this file. Style preferences, refactoring opportunities, and naming nits do not count. If there are no actual bugs, output EXACTLY this token and nothing else: NO_BUGS',
    maxTokens: 60,
    groundTruth: 'NO_BUGS',
  },
  {
    id: 'T7',
    description: 'precision counting',
    fixturePath: `${REPO_ROOT_FROM_SCRIPTS}/packages/agentchat/src/worker/dispatcher.ts`,
    fixtureLabel: 'dispatcher.ts',
    question:
      'Exactly how many times does the literal string "releaseSemaphore" appear in this file (case-sensitive, count every occurrence)? Output only the integer.',
    maxTokens: 8,
    groundTruth: '2',
  },
  {
    id: 'T8',
    description: 'disambiguation',
    fixturePath: `${REPO_ROOT_FROM_SCRIPTS}/packages/agentchat/src/worker/dispatcher.ts`,
    fixtureLabel: 'dispatcher.ts',
    question:
      'Does the dispatcher use a mutex, a semaphore, or both? Output exactly ONE of: mutex, semaphore, both. No period. No explanation.',
    maxTokens: 8,
    groundTruth: 'both',
  },
];

export const BENCH_SYSTEM_PROMPT =
  'Follow output format requirements exactly. Do not add commentary, headers, hedges, or explanations unless explicitly asked.';
```

- [ ] **Step 2.2: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add packages/agentchat/scripts/bench-prompts.ts
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "feat(agentchat): extract bench-2 prompts into bench-prompts.ts"
```

---

### Task 3: Write the runnable bench harness with TDD

**Files:**
- Create: `packages/agentchat/scripts/bench.ts`
- Create: `packages/agentchat/scripts/bench.test.ts`

The harness exports a `runBench(opts)` function (testable) and runs as a CLI when invoked via `bun packages/agentchat/scripts/bench.ts ...` (`if (import.meta.main)` guard at the bottom).

- [ ] **Step 3.1: Write the failing test**

```ts
// packages/agentchat/scripts/bench.test.ts
import { expect, test } from 'bun:test';
import { runBench, type BenchResult } from './bench.js';

test('runBench: returns one result per task in BENCH_TASKS, all stub-served', async () => {
  let calls = 0;
  const stub = Bun.serve({
    port: 0,
    fetch: () => {
      calls++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'STUB_REPLY' } }],
        model: 'stub-model',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/v1`;
    const results: BenchResult[] = await runBench({ label: 'stub-test', url, model: 'stub' });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.label).toBe('stub-test');
      expect(r.task).toMatch(/^T[4-8]$/);
      expect(r.model).toBe('stub');
      expect(r.answer).toBe('STUB_REPLY');
      expect(typeof r.latencyMs).toBe('number');
      expect(r.error).toBeUndefined();
    }
    expect(calls).toBe(5);
  } finally { stub.stop(); }
});

test('runBench: missing fixture file is captured per-task without aborting the run', async () => {
  const stub = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { headers: { 'content-type': 'application/json' } }),
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/v1`;
    // Override one fixture to a missing path via opts.fixtureOverrides
    const results = await runBench({
      label: 'fixture-test',
      url,
      model: 'stub',
      fixtureOverrides: { T4: '/tmp/this-file-definitely-does-not-exist-zzz.md' },
    });
    expect(results.length).toBe(5);
    const t4 = results.find(r => r.task === 'T4')!;
    expect(t4.error).toMatch(/fixture/i);
    expect(t4.answer).toBeUndefined();
    // Other tasks still ran
    expect(results.filter(r => !r.error).length).toBe(4);
  } finally { stub.stop(); }
});

test('runBench: stub returning empty body is captured as an error, not a crash', async () => {
  const stub = Bun.serve({
    port: 0,
    fetch: () => new Response('', { headers: { 'content-type': 'application/json' } }),
  });
  try {
    const url = `http://127.0.0.1:${stub.port}/v1`;
    const results = await runBench({ label: 'empty-test', url, model: 'stub' });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.error).toBeDefined();
      expect(r.answer).toBeUndefined();
    }
  } finally { stub.stop(); }
});
```

- [ ] **Step 3.2: Run the tests — confirm they fail**

```bash
bun test packages/agentchat/scripts/bench.test.ts 2>&1 | tail -10
```

Expected: import error / module-not-found for `./bench.js`.

- [ ] **Step 3.3: Write the harness**

```ts
// packages/agentchat/scripts/bench.ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_TASKS, BENCH_SYSTEM_PROMPT, type BenchTask } from './bench-prompts.js';

export interface RunBenchOpts {
  label: string;
  url: string;          // e.g. http://127.0.0.1:8080/v1
  model: string;        // e.g. local, meta/llama-3.1-8b-instruct
  authToken?: string;   // Bearer token; omit for anonymous endpoints
  caPath?: string;      // PEM file with extra trusted CAs (self-signed servers)
  /** Override one or more task fixtures (testing seam). */
  fixtureOverrides?: Partial<Record<BenchTask['id'], string>>;
}

export interface BenchResult {
  label: string;
  model: string;
  task: BenchTask['id'];
  description: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  answer?: string;
  groundTruth: string;
  latencyMs: number;
  error?: string;
}

/**
 * Resolve a fixture path. The constants in bench-prompts.ts use repo-relative
 * paths starting from `packages/agentchat/scripts/`; this anchors them to the
 * absolute repo root regardless of cwd.
 */
function resolveFixture(scriptsDir: string, fixturePath: string): string {
  return resolve(scriptsDir, fixturePath);
}

export async function runBench(opts: RunBenchOpts): Promise<BenchResult[]> {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const results: BenchResult[] = [];

  for (const task of BENCH_TASKS) {
    const start = Date.now();
    try {
      const fixturePath = opts.fixtureOverrides?.[task.id]
        ? resolve(opts.fixtureOverrides[task.id]!)
        : resolveFixture(scriptsDir, task.fixturePath);
      if (!existsSync(fixturePath)) {
        throw new Error(`fixture not found: ${fixturePath}`);
      }
      const fixtureBody = readFileSync(fixturePath, 'utf8');
      const userContent = `--- File: ${task.fixtureLabel} ---\n${fixtureBody}\n\n---\n\n${task.question}`;
      const body = JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: task.maxTokens,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: BENCH_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;
      const init: any = {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(120_000),
      };
      if (opts.caPath) init.tls = { ca: readFileSync(opts.caPath, 'utf8') };

      const res = await fetch(`${opts.url.replace(/\/$/, '')}/chat/completions`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length === 0) throw new Error('empty response body');
      let json: any;
      try { json = JSON.parse(text); }
      catch { throw new Error(`non-JSON body: ${text.slice(0, 80)}`); }
      const msg = json?.choices?.[0]?.message;
      const answer = (msg?.content && msg.content.length > 0)
        ? msg.content
        : (msg?.reasoning_content ?? '');
      results.push({
        label: opts.label,
        model: opts.model,
        task: task.id,
        description: task.description,
        prompt_tokens: json?.usage?.prompt_tokens,
        completion_tokens: json?.usage?.completion_tokens,
        answer,
        groundTruth: task.groundTruth,
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        label: opts.label,
        model: opts.model,
        task: task.id,
        description: task.description,
        groundTruth: task.groundTruth,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// CLI entry: parses flags and prints one JSON line per task.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const label = flag('label');
  const url = flag('url');
  const model = flag('model') ?? 'local';
  const authToken = flag('auth-token');
  const caPath = flag('auth-cert');
  if (!label || !url) {
    console.error('usage: bun bench.ts --label NAME --url URL [--model M] [--auth-token T] [--auth-cert PATH]');
    process.exit(1);
  }
  const out = await runBench({ label, url, model, authToken, caPath });
  for (const r of out) console.log(JSON.stringify(r));
}
```

- [ ] **Step 3.4: Run the tests — confirm they pass**

```bash
bun test packages/agentchat/scripts/bench.test.ts 2>&1 | tail -8
```

Expected: 3 pass / 0 fail.

- [ ] **Step 3.5: Smoke-run the CLI against the running local llama-server**

Confirm a real run produces JSON output. Requires the local llama-server running (gemma 4 26B-A4B at :8080).

```bash
bun /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/scripts/bench.ts \
  --label gemma4-26b-smoke \
  --url http://127.0.0.1:8080/v1 \
  --model local 2>&1 | head -10
```

Expected: 5 lines of JSON, each with `task` matching T4..T8, `answer` populated. If the server isn't running, you'll see connection errors per task — those are captured in `error` and the run still completes.

- [ ] **Step 3.6: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add \
  packages/agentchat/scripts/bench.ts \
  packages/agentchat/scripts/bench.test.ts
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "feat(agentchat): runnable bench harness for model calibration

Ports /tmp/penumbra-dispatch/bench2.sh into TypeScript:
- runBench({label, url, model, authToken?, caPath?}) returns 5 BenchResult
  rows (one per task), capturing per-task errors without aborting the run
- CLI: bun packages/agentchat/scripts/bench.ts --label NAME --url URL
- Reads fixtures from the repo at run time so a bench reflects current code
- 3 tests cover happy path, missing-fixture, empty-body cases via Bun.serve stubs"
```

---

### Task 4: Write `agent-fleet.md`

**Files:**
- Create: `packages/agentchat/docs/agent-fleet.md`

- [ ] **Step 4.1: Create the docs dir**

```bash
mkdir -p /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/docs
```

- [ ] **Step 4.2: Write the doc**

```markdown
# Agent fleet — calibration + routing reference

Operating reference for picking the right agent for a task. Calibration data and routing recommendations come from `bench-2`, run via `packages/agentchat/scripts/bench.ts` against each candidate model.

## Bench-2 tasks (5 micro-benchmarks)

Each model is evaluated on:

| Task | Tests |
|---|---|
| T4 | long-context retrieval (READ from a 250-line file, return one integer) |
| T5 | multi-step reasoning (predict behavior of a lock + semaphore under contention) |
| T6 | format under tension (clean file: must answer `NO_BUGS` and resist nit-drift) |
| T7 | precision counting (exact occurrence count of a string) |
| T8 | disambiguation (mutex / semaphore / both — pick one word) |

## Results (2026-04-26)

| Model | Active params | Type | T4 | T5 | T6 | T7 | T8 | Net |
|---|---|---|---|---|---|---|---|---|
| Gemma 4 E4B (mac-mini) | 4B | dense | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Qwen 3.5 4B Q4_K_XL | 4B | dense | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Gemma 4 26B-A4B Q4_K_XL | 4B active | MoE A4B | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Gemma 4 31B Q4_K_XL | 31B | dense | pedantic | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Qwen 3.5 27B Q5_K_XL | 27B | dense | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| Qwen 3.6 27B Q4_K_XL | 27B | dense | ✓ | ✓ | ✓ | ✗ 3 | ✓ | **4/5** |
| Qwen 3.6 35B-A3B Q4_K_M | 3B active | MoE A3B | ✓ | ✗ logic backwards | ✓ | ✗ 3 | ✓ | **3/5** |
| Qwen 3.6 35B-A3B Q4_K_XL | 3B active | MoE A3B | ✓ | ✗ logic backwards | ✓ | ✗ 3 | ✓ | **3/5** |
| Qwen3-Coder-30B-A3B Q4_K_XL (local) | 3B active | MoE A3B (coder) | ✓ | ✗ logic backwards | ✓ | ✓ | ✓ | **4/5** |
| nv-llama4-maverick (NVIDIA) | 17B/128E | MoE | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| nv-qwen3-coder-480b (NVIDIA) | 35B active | MoE A35B (coder) | ✓ | ✓ | ✓ | ✓ | ✓ | **5/5** |
| nv-llama-3.1-8b (NVIDIA) | 8B | dense | ✓ | ✓ | ✗ false-positive | rate-limited | ✗ "semaphore" | **2/5** |
| nv-deepseek-v4-pro (NVIDIA) | — | — | rate-limited | ✓ | rate-limited | ✓ | rate-limited | times-out at >2KB prompts |
| nv-nemotron-super-49b (NVIDIA) | 49B | dense (reasoning) | format-fail | format-fail | format-fail | format-fail | format-fail | leaks chain-of-thought into content |

T4 was poorly specified — README only *shows* `--concurrency 4` in an example, never *states* the default. Smaller Gemmas inferred from context (practical); Gemma 4 31B refused (pedantic). Both are defensible.

## Architecture pattern

**Qwen 3.x A3B MoE (3B active) consistently fails T5 reasoning.** Quant doesn't fix it (Q4_K_M and Q4_K_XL behave identically). Coder specialty doesn't fix it (Qwen3-Coder-30B-A3B shows the same pathology). The 3B active routing is too thin for our task profile. The 480B coder variant on NVIDIA (35B active) clears the bar — A3B vs A35B is the load-bearing distinction.

Dense models — across every size and series tested (4B → 31B) — are reliable on this bench. MoE works when the active path is wide enough (Gemma 4 A4B, Qwen3 A35B).

## Sweet-spot pairings

| Task profile | Pick |
|---|---|
| Quick extraction / yes-no / format-strict (low cost) | mac-mini Gemma 4 E4B (`@planner` or `@executor`) |
| Code review / multi-step reasoning / focused single-file dives | local Gemma 4 26B-A4B MoE (`@local-gemma26`) |
| Pedantic literal-vs-implied (e.g. spec compliance check) | local Gemma 4 31B dense (`@local-gemma31`, swap required) |
| Frontier general / vision (cloud) | `@nv-llama4-maverick` (NVIDIA, free-tier ~40 rpm) |
| Frontier coder (cloud) | `@nv-qwen3-coder-480b` (NVIDIA — clears the A3B blind spot) |
| Qwen-lineage perspective on reasoning | `@local-qwen35-27b` (legacy dense, swap required) |
| Lightweight local fallback | `@local-qwen35-4b` (swap required) |

## AVOID for our profile

- **any Qwen 3.x A3B MoE** (35B base AND coder) — fails T5 reasoning regardless of quant or specialty.
- **NVIDIA `deepseek-v4-pro` / `deepseek-v4-flash`** on free tier — works for trivial prompts, times out at 90s on anything with file context (>~2KB request body).
- **NVIDIA `llama-3.1-8b`** — 2/5; mac-mini Gemma 4 E4B beats it on the same bench at 0 cost.
- **NVIDIA `llama-3.3-nemotron-super-49b-v1.5`** — leaks chain-of-thought into the content field; format adherence broken.

## Reproducing the calibration

```bash
# Local llama-server (swap target via llamactl):
bun packages/agentchat/scripts/bench.ts \
  --label gemma4-26b \
  --url http://127.0.0.1:8080/v1 \
  --model local

# NVIDIA NIM (replace with your nvapi key reference):
NVAPI=$(security find-generic-password -s llamactl -a nvidia -w)
bun packages/agentchat/scripts/bench.ts \
  --label nv-qwen3-coder-480b \
  --url https://integrate.api.nvidia.com/v1 \
  --model qwen/qwen3-coder-480b-a35b-instruct \
  --auth-token "$NVAPI"

# Mac-mini gemma (self-signed CA):
bun packages/agentchat/scripts/bench.ts \
  --label gemma4-e4b-mac-mini \
  --url https://192.168.68.76:7843/v1 \
  --model gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf \
  --auth-token "$LLAMACTL_TOKEN_MAC_MINI" \
  --auth-cert /tmp/llamactl-mac-mini-ca.pem
```

Each invocation prints one JSON line per task to stdout. To compare a new model against the table, eyeball the `answer` vs `groundTruth` fields and update the row above.

## Per-agent quirks

The agentchat config (`~/.config/agentchat/agentchat.yaml`) carries a `quirks` field per agent — empirical observations from past use. When routing, scan those before dispatch. Highlights:

- **mac-mini Gemma 4 E4B** drifts into style nits if the prompt allows; tighten constraints. Punches above 4B weight.
- **local Gemma 4 26B-A4B MoE** tends to label "concern" findings as "bug"; re-read its findings before acting.
- **Gemma 4 31B (dense)** is pedantic — says "not specified" where smaller gemmas infer values. Use this exact behavior when literal correctness matters.
- **`@gemini` / `@claude` / `@codex`** are agentic CLIs with native file/shell tools — they'll write files but unreliable on per-task git commits via agentchat. Always verify with `git status` after.
- **NVIDIA NIM cloud agents** are capped ~40 rpm on free tier — serialize calls when running batches. `/v1/models` is publicly readable without auth, useful for catalog browsing.
```

- [ ] **Step 4.3: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add packages/agentchat/docs/agent-fleet.md
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "docs(agentchat): agent-fleet calibration + routing reference"
```

---

### Task 5: Write `dispatch-examples.md`

**Files:**
- Create: `packages/agentchat/docs/dispatch-examples.md`

- [ ] **Step 5.1: Write the doc**

```markdown
# Dispatch examples — common agentchat invocations

Concrete patterns for `agentchat new`, `agentchat-worker`, and the MCP `chain.start` tool. Pair with `agent-fleet.md` for picking the right agent and `openai-compat-keys.md` for credential refs.

## One-shot, headless (the most common pattern)

Pipe a prompt to `agentchat new --auto`. The bin treats stdin as a single message (no blank-line splitting) and dispatches one hop, halting after the first reply.

```bash
echo "@local-gemma26 Reply with exactly: OK" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1
```

Expected output:
```
[local-gemma26]
OK
```

`--auto` enables auto-approval of every continuation handoff. With `--max-hops 1` the chain caps after one dispatch even if the reply contains a `@mention`.

## Multi-hop with a hop budget

```bash
echo "@planner: triage the new bug report and route to @executor" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 5 --transcript-budget 16384
```

`--transcript-budget` limits how much prior context is wrapped into each hop's prompt. The transcript is truncated from the front (oldest user message stays last; older agent replies drop first).

## Inline file attachments (`--attach`)

`openai-compat-http` agents (local llama-server, NVIDIA NIM, mac-mini gemma) have NO native file-reading tools. Use `--attach <path>` to pre-pend file content to the first user message using the same `--- File: <name> ---` header that llama-server's web chat UI uses.

```bash
echo "@local-gemma26 Review the attached file. Output: Bugs, Concerns, Verdict (LGTM or NEEDS FIXES). Stay under 400 words." \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1 \
      --attach packages/agentchat/src/worker/dispatcher.ts
```

Repeatable: `--attach a.md --attach b.md ...`. Files are inlined into the FIRST user message only; subsequent hops use the conversation transcript.

## Per-edge trust (`--trust`)

Use `--trust` (instead of `--auto`) when you want only specific edges auto-approved. Each agent's `auto_approve_to` field in `agentchat.yaml` lists which targets it can dispatch to without human approval. Untrusted edges leave the next handoff `pending`.

```bash
echo "@planner: implement the rate-limiter described in the spec" \
  | bun packages/agentchat/bin/agentchat.ts new --trust --max-hops 5
```

If `planner.auto_approve_to: [executor]`, the planner→executor edge auto-approves. If executor's reply mentions `@reviewer` and `executor.auto_approve_to` does NOT include `reviewer`, the chain pauses — the bin prints `[chain stopped at untrusted edge, handoff abc12345 queued]` and you can approve manually:

```bash
bun packages/agentchat/bin/agentchat.ts approve abc12345
```

## Bin streaming vs worker dispatch

The interactive bin (`agentchat new --auto`) dispatches in-process and streams adapter output live to stdout. Latency-sensitive interactive workflows want the bin.

The worker (`agentchat-worker`, phase-1) drains approved handoffs out-of-process. Use it when the chain runs without a TTY — cron jobs, MCP-driven kicks, webhooks.

```bash
# Start the worker (keep it running):
bun packages/agentchat/bin/agentchat-worker.ts \
  --storage-root /tmp/penumbra-live --concurrency 4 --poll-interval 1000

# Then kick off a chain headlessly via daemon HTTP:
curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
  -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  -H 'content-type: application/json' \
  -d '{"initial_agent":"local-gemma26","message":"@executor: ping","max_hops":5,"trust_mode":"all"}'
```

The chain runs entirely in the worker; the curl call returns immediately with `{conversation_id, handoff_id}`. Poll `GET /handoffs?conversation_id=<id>&status=pending,approved,dispatched` until empty to detect chain idle.

In phase 1 the bin and worker can both produce/dispatch approved handoffs — `claimDispatch` makes worker-vs-worker races safe, but the bin doesn't go through claim, so don't run `--auto` and the worker against the same conversation simultaneously.

## MCP `chain.start` (for non-shell callers)

The penumbra MCP server exposes `chain.start` as a tool. Any AI harness (Claude Code, Cursor, Gemini CLI) with the penumbra MCP wired up can call:

```
chain.start({
  initial_agent: "local-gemma26",
  message: "@executor: ping",
  max_hops: 5,
  trust_mode: "all"
})
```

→ returns `{conversation_id, handoff_id}`. Same poll-for-completion pattern.

## Common pitfalls

**`parseInputStream` whole-mode behavior on piped stdin.** When stdin is a pipe (non-TTY), the bin treats the entire stream as ONE message — no blank-line splitting, no `done` sentinel. Multi-paragraph markdown stays intact. In TTY mode (interactive), blank lines still separate messages.

**Attachment header convention.** `--attach` uses the EXACT `\n\n--- File: <basename> ---\n<content>` template that llama-server's web UI uses, so any model trained on that template (Gemma 4, Qwen 3.x) reads attachments naturally without needing tool-use support.

**Cloud rate limits.** NVIDIA NIM free tier is ~40 rpm. If you fan-out 5 models × 5 prompts in parallel you'll hit the cap mid-run and get empty bodies. Serialize when running batches.

**Worker requires the daemon.** `agentchat-worker` connects to `/tmp/penumbra-live` (the daemon's storage root). Run `bun packages/cli/bin/penumbra.ts start --detach` first.
```

- [ ] **Step 5.2: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add packages/agentchat/docs/dispatch-examples.md
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "docs(agentchat): dispatch-examples cookbook for new/auto/attach/trust/worker"
```

---

### Task 6: Write `openai-compat-keys.md`

**Files:**
- Create: `packages/agentchat/docs/openai-compat-keys.md`

- [ ] **Step 6.1: Write the doc**

```markdown
# openai-compat-http credentials reference

The `openai-compat-http` adapter accepts four key sources in `agentchat.yaml`. They mirror llamactl's `keychain:` / `env:` / `file:` ref convention so secrets stay out of the YAML in plaintext.

## The four sources

```yaml
options:
  apiKey: nvapi-...                 # literal — back-compat, fine for trusted on-disk configs
  apiKeyEnv: NVIDIA_API_KEY         # process.env lookup
  apiKeyKeychain: llamactl/nvidia   # macOS Keychain ref: <service>/<account>
  apiKeyFile: /path/to/key.txt      # trimmed file content
```

**Resolution precedence (first non-empty wins):** `apiKey` > `apiKeyEnv` > `apiKeyKeychain` > `apiKeyFile` > empty.

If none is provided the adapter sends an empty `Authorization: Bearer ` header — fine for anonymous endpoints (a dev llama-server on loopback). Cloud endpoints will return 401.

The legacy snake_case alias `api_key_env` is still accepted for back-compat.

## macOS Keychain cookbook (recommended for cloud keys)

Stash a key in the keychain:

```bash
security add-generic-password -U -s llamactl -a nvidia -T '' -w
# (paste the nvapi-... key when prompted; -w with no value reads from stdin)
```

`-U` overwrites if the entry exists (idempotent re-runs). `-T ''` restricts ACL so only apps that explicitly request access can read it — first read prompts you to "Always Allow" the bun binary.

Reference it from `agentchat.yaml`:

```yaml
- name: nv-qwen3-coder-480b
  adapter: openai-compat-http
  options:
    baseUrl: https://integrate.api.nvidia.com/v1
    apiKeyKeychain: llamactl/nvidia
    model: qwen/qwen3-coder-480b-a35b-instruct
    maxTokens: 1024
```

Verify the key resolves:

```bash
security find-generic-password -s llamactl -a nvidia -w
```

Outputs the value (with another keychain prompt the first time). To rotate, re-run `add-generic-password -U` with the new value.

## Env var pattern

When a key is already in env (e.g. CI, dotfile-managed):

```yaml
options:
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: OPENAI_API_KEY
  model: gpt-4o-mini
```

The bin throws if `process.env.OPENAI_API_KEY` is unset/empty — the error names the var so misconfigs are obvious.

## File pattern

```yaml
options:
  apiKeyFile: /Users/acordeiro/.llamactl/secrets/sirius-dev.key
```

The file's full content is read and trimmed (handles trailing newlines from text editors). No additional escaping or format requirement.

## Anonymous endpoints

For dev llama-server on loopback (no auth):

```yaml
- name: local-gemma26
  adapter: openai-compat-http
  options:
    baseUrl: http://127.0.0.1:8080/v1
    apiKey: local-no-auth
    model: local
```

Or simply omit all four key sources — the adapter sends an empty `Authorization` header which anonymous endpoints ignore. The literal `local-no-auth` is purely cosmetic; it documents intent.

## Concrete entries already in agentchat.yaml

- `planner` / `executor` (mac-mini gemma) — literal `apiKey` (LAN-private endpoint, low risk).
- `local-gemma26` — anonymous (`apiKey: local-no-auth`).
- `nv-llama4-maverick` / `nv-qwen3-coder-480b` / etc. — `apiKeyKeychain: llamactl/nvidia`.
- `local-qwen36-35b-moe` — anonymous, but wired with `extraBody.chat_template_kwargs.enable_thinking: false` to suppress qwen's thinking mode.
```

- [ ] **Step 6.2: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add packages/agentchat/docs/openai-compat-keys.md
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "docs(agentchat): openai-compat-keys reference for apiKey/Env/Keychain/File"
```

---

### Task 7: Write penumbra `AGENTS.md`

**Files:**
- Modify: `/Volumes/WorkSSD/repos/personal/penumbra/AGENTS.md` (currently a stub)

- [ ] **Step 7.1: Replace the stub with full content**

```markdown
# penumbra

Local-first observability + cross-agent chat orchestrator. Records LLM activity (t0 events, t1 rollups, t2 long-term memories) and brokers handoffs between AI agents (Claude / Gemini / Codex / local LLMs) via `@mention` syntax with a human-in-the-loop approval gate.

## Architecture

Bun + TypeScript monorepo (`bun` package manager, workspaces). Top-level packages:

- `packages/core` — shared primitives: schemas (zod), writers (HandoffWriter, T0Writer, T1Rollup), readers, in-memory event bus (HandoffEventBus), context-file generator (ContextFileWriter), supervisor for periodic workers.
- `packages/daemon` — long-running HTTP server. Hosts the t0 ingest endpoint, recall over t1+t2 vectors, handoffs CRUD + claim/complete/SSE-events routes, chains/start. Runs the t1-rollup background worker.
- `packages/agentchat` — `@mention`-driven chat orchestrator. Bin: `agentchat new` (interactive + `--auto` headless modes); separate `agentchat-worker` long-running process that dispatches approved handoffs out-of-bin. Adapters: `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`.
- `packages/cli` — `penumbra` operator CLI. `start --detach`, `stop`, `status`, `repair`, `init`, export/import.
- `packages/mcp` — Model Context Protocol server exposing `memory.observe`, `memory.recall`, `session.end`, `handoff.list_pending`, `handoff.approve`, `chain.start` to agentic harnesses.
- `packages/integrations/sirius-middleware` — fastify middleware for sirius-gateway → t0 fan-in.
- `packages/e2e` — full-stack smoke tests against a real daemon.

## Quick reference

```bash
# Install
bun install

# Type-check + run all tests
bun typecheck
bun test

# Per-package tests (the monorepo bun test occasionally hits a Bun ONNX
# teardown panic at the very end; the panic is COSMETIC — judge by
# pass/fail counts, not exit code):
bun test packages/core/test/schemas
bun test packages/daemon/test/routes
bun test packages/agentchat/test/cli

# Run the daemon
bun packages/cli/bin/penumbra.ts start --detach
# Stop it
bun packages/cli/bin/penumbra.ts stop

# Run agentchat (interactive + auto modes):
echo "@local-gemma26 reply with: OK" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1

# Run the headless worker (talks to the daemon):
bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live

# Run the model calibration bench:
bun packages/agentchat/scripts/bench.ts --label NAME --url URL --model M
```

## Conventions

- **Conventional commits**, no AI / agent attribution in commit messages. The user takes attribution. Operating undercover.
- **TDD discipline** for new code: failing test → run red → minimal implementation → run green → commit per logical chunk.
- **Default to no comments.** Only add a comment when the WHY is non-obvious (a hidden constraint, a workaround, surprising behavior).
- **No backward-compatibility hacks** for unused code. If something's unused, delete it.
- **Bun ONNX teardown panic** at end of `bun test` is cosmetic. Look at pass/fail line above the panic.
- Test fixtures use `bun:sqlite`. macOS sqlite-vec dynamic extension support is centralized in `test/setup.ts` (preloaded via `bunfig.toml`).

## MCP surface

Penumbra ships an MCP server at `packages/mcp/bin/penumbra-mcp.ts`. Tools:

- `memory.observe` — write a t0 event (LLM call, tool call, custom)
- `memory.recall` — semantic-search t1+t2 by query
- `session.end` — trigger a synchronous t1 rollup for a session
- `handoff.list_pending` — list handoffs awaiting approval
- `handoff.approve` — approve / redirect / reject a handoff
- `chain.start` — kick off an agentchat chain headlessly (the agentchat-worker dispatches)

To wire into your agentic harness, see the user-level config snippets in this fleet's MCP wiring docs (Claude `~/.claude/settings.json`, Gemini `~/.gemini/settings.json`, Codex `~/.codex/config.toml`). Prereq: penumbra daemon running (`bun packages/cli/bin/penumbra.ts start --detach`).

## Cross-agent doc center

`packages/agentchat/docs/` carries the calibration + dispatch references — these are the load-bearing docs for "which agent for what task":

- `agent-fleet.md` — bench-2 results table, sweet-spot pairings, AVOID list, architecture-pattern observations.
- `dispatch-examples.md` — concrete `--auto` / `--attach` / `--max-hops` / `--trust` recipes; bin-vs-worker; MCP `chain.start`.
- `openai-compat-keys.md` — `apiKey` / `apiKeyEnv` / `apiKeyKeychain` / `apiKeyFile` resolution precedence.
- `scripts/bench.ts` — runnable bench harness; reproduce calibrations or evaluate new models.

The agentchat config (`~/.config/agentchat/agentchat.yaml`) carries `description` / `tags` / `quirks` per agent — empirical guidance for routing decisions. Read those before dispatching.

## Related fleet tools

- **llamactl** (`/Volumes/WorkSSD/repos/personal/llamactl`) — runs local llama-server instances (`server start <gguf>`), manages the model catalog, registers cloud nodes (NVIDIA NIM lives here as `nvidia-nim`). The agentchat `local-*` agents talk to whatever model llamactl currently serves at `127.0.0.1:8080`.
- **sirius-gateway** (`/Volumes/WorkSSD/repos/personal/sirius-gateway`) — multi-provider OpenAI-compat gateway. Penumbra has a dedicated `packages/integrations/sirius-middleware` for fanning sirius traffic into t0.
- **embersynth** (`/Volumes/WorkSSD/repos/personal/embersynth`) — see its AGENTS.md.

## Where to dig deeper

- `README.md` (top-level) — vision and architecture overview.
- `packages/agentchat/README.md` — agentchat's full operator surface.
- `docs/superpowers/specs/2026-04-26-agentchat-daemon-worker-design.md` — daemon-worker (phase 1) spec.
- `docs/superpowers/specs/2026-04-26-tooling-knowledge-distribution-design.md` — this knowledge-distribution effort.
- `docs/superpowers/plans/` — implementation plans; one per significant feature.
```

- [ ] **Step 7.2: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add AGENTS.md
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "docs: populate top-level AGENTS.md as canonical agentic-tool entry point"
```

---

### Task 8: Write penumbra pointer files (CLAUDE.md / GEMINI.md / JULES.md)

**Files:**
- Modify: `/Volumes/WorkSSD/repos/personal/penumbra/CLAUDE.md`
- Modify: `/Volumes/WorkSSD/repos/personal/penumbra/GEMINI.md`
- Modify: `/Volumes/WorkSSD/repos/personal/penumbra/JULES.md`

- [ ] **Step 8.1: Confirm the stubs exist (otherwise create them)**

```bash
ls /Volumes/WorkSSD/repos/personal/penumbra/CLAUDE.md \
   /Volumes/WorkSSD/repos/personal/penumbra/GEMINI.md \
   /Volumes/WorkSSD/repos/personal/penumbra/JULES.md
```

If any is missing, just create it via the steps below.

- [ ] **Step 8.2: Write the three pointer files (identical content)**

`CLAUDE.md`:

```markdown
# penumbra — Claude Code notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
```

`GEMINI.md`:

```markdown
# penumbra — Gemini CLI notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
```

`JULES.md`:

```markdown
# penumbra — Jules notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
```

- [ ] **Step 8.3: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/penumbra add CLAUDE.md GEMINI.md JULES.md
git -C /Volumes/WorkSSD/repos/personal/penumbra commit -m "docs: pointer files redirect Claude/Gemini/Jules to AGENTS.md"
```

---

## Wave C — Per-repo `AGENTS.md` (fleet-drafted) + pointer files

Each repo gets its own commit. The `AGENTS.md` is dispatched to a specific agent; the pointer files are hand-written from the same template as Task 8.

The template each fleet draft must structurally match (same as penumbra's, scaled to the repo):

```
# <tool name>
<elevator pitch>
## Architecture
## Quick reference
## Conventions
## MCP surface
## Related fleet tools
## Where to dig deeper
```

### Task 9: Draft + commit `llamactl/AGENTS.md`

**Files:**
- Modify: `/Volumes/WorkSSD/repos/personal/llamactl/AGENTS.md`
- Modify: `/Volumes/WorkSSD/repos/personal/llamactl/CLAUDE.md`
- Modify: `/Volumes/WorkSSD/repos/personal/llamactl/GEMINI.md`
- Modify: `/Volumes/WorkSSD/repos/personal/llamactl/JULES.md`

- [ ] **Step 9.1: Build the dispatch prompt**

The prompt instructs `@local-gemma26` to draft `AGENTS.md` for llamactl. We attach (a) the template (the penumbra `AGENTS.md` we just wrote), (b) llamactl's `README.md`, (c) llamactl's `package.json`, (d) the CLI bin entry, (e) a recent `--help` output for landmarks.

```bash
mkdir -p /tmp/penumbra-dispatch

# Capture the help text as an attached fixture
cd /Volumes/WorkSSD/repos/personal/llamactl
bun packages/cli/src/bin.ts --help > /tmp/penumbra-dispatch/llamactl-help.txt 2>&1
bun packages/cli/src/bin.ts node --help > /tmp/penumbra-dispatch/llamactl-node-help.txt 2>&1

cat > /tmp/penumbra-dispatch/llamactl-agents-prompt.txt <<'EOF'
@local-gemma26 You are drafting an AGENTS.md for the llamactl repo at /Volumes/WorkSSD/repos/personal/llamactl. The attached fixtures include: the EXAMPLE template (penumbra's AGENTS.md), llamactl's README.md, llamactl's root package.json, llamactl's CLI top-level help, llamactl's node-subcommand help.
.
Produce ONE complete AGENTS.md for the llamactl repo. Match the EXAMPLE template's section structure EXACTLY (## Architecture, ## Quick reference, ## Conventions, ## MCP surface, ## Related fleet tools, ## Where to dig deeper). Length target: ~120 lines.
.
Non-negotiables:
.
- Conventional commits, NO AI / agent attribution in any examples
- Cite real top-level packages (look at the README + package.json)
- Quick reference must include actual commands the user runs (bun packages/cli/src/bin.ts ...)
- "MCP surface" section: llamactl has a packages/mcp; describe its tools at a high level if visible from the README, otherwise say it exists and points to the bin
- "Related fleet tools" must mention penumbra (cross-agent chat / observation), sirius-gateway (multi-provider OpenAI-compat gateway), embersynth (TBD), with a 1-line description each
- "Where to dig deeper" must list real file paths from llamactl's tree
.
Output ONLY the markdown content of AGENTS.md inside a single fenced code block, starting with `# llamactl` and ending with the last paragraph. No commentary outside the block.
.
done
EOF
```

- [ ] **Step 9.2: Dispatch the draft**

```bash
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live \
bun /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/bin/agentchat.ts new --auto --max-hops 1 --transcript-budget 32768 \
  --attach /Volumes/WorkSSD/repos/personal/penumbra/AGENTS.md \
  --attach /Volumes/WorkSSD/repos/personal/llamactl/README.md \
  --attach /Volumes/WorkSSD/repos/personal/llamactl/package.json \
  --attach /tmp/penumbra-dispatch/llamactl-help.txt \
  --attach /tmp/penumbra-dispatch/llamactl-node-help.txt \
  < /tmp/penumbra-dispatch/llamactl-agents-prompt.txt \
  > /tmp/penumbra-dispatch/llamactl-agents-draft.log 2>&1
```

Expected: bin runs, model produces a fenced markdown block with the AGENTS.md content. The exact response is in the log file.

- [ ] **Step 9.3: Extract the draft from the response**

```bash
# The fenced block ends with ``` followed by the bin's "[max-hops 1 reached..." log line.
awk '/^```markdown$/,/^```$/' /tmp/penumbra-dispatch/llamactl-agents-draft.log \
  | sed '1d;$d' \
  > /tmp/penumbra-dispatch/llamactl-AGENTS-draft.md
wc -l /tmp/penumbra-dispatch/llamactl-AGENTS-draft.md
head -3 /tmp/penumbra-dispatch/llamactl-AGENTS-draft.md
```

Expected: a non-empty markdown file. If the awk extraction returns 0 lines, look at the raw log — the model may have used backticks differently (no `markdown` language tag, or used a tilde fence). Adjust the awk pattern or extract manually.

- [ ] **Step 9.4: Gate-check the draft against the template**

Visual review the draft and confirm:

- [ ] Starts with `# llamactl`
- [ ] Has all 6 required sections (`## Architecture`, `## Quick reference`, `## Conventions`, `## MCP surface`, `## Related fleet tools`, `## Where to dig deeper`)
- [ ] Quick reference mentions real commands (look for `bun packages/cli/src/bin.ts` somewhere)
- [ ] Conventions mention "no AI / agent attribution" or equivalent
- [ ] Related fleet tools mentions penumbra (line containing `penumbra`)
- [ ] Where to dig deeper has at least 3 file path bullets

If any check fails, edit the draft directly with the missing content. If the section structure is fundamentally wrong (only 3 of 6 sections), discard the draft and hand-write from the template.

- [ ] **Step 9.5: Move the draft into place**

```bash
cp /tmp/penumbra-dispatch/llamactl-AGENTS-draft.md \
   /Volumes/WorkSSD/repos/personal/llamactl/AGENTS.md
```

- [ ] **Step 9.6: Write the 3 pointer files**

```bash
cat > /Volumes/WorkSSD/repos/personal/llamactl/CLAUDE.md <<'EOF'
# llamactl — Claude Code notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF

cat > /Volumes/WorkSSD/repos/personal/llamactl/GEMINI.md <<'EOF'
# llamactl — Gemini CLI notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF

cat > /Volumes/WorkSSD/repos/personal/llamactl/JULES.md <<'EOF'
# llamactl — Jules notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF
```

- [ ] **Step 9.7: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/llamactl add AGENTS.md CLAUDE.md GEMINI.md JULES.md
git -C /Volumes/WorkSSD/repos/personal/llamactl commit -m "docs: populate AGENTS.md (canonical) + Claude/Gemini/Jules pointers"
```

---

### Task 10: Draft + commit `sirius-gateway/AGENTS.md`

Same shape as Task 9 but dispatches to `@nv-qwen3-coder-480b` (frontier coder, handles the large repo context).

**Files:**
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/AGENTS.md`
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/CLAUDE.md`
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/GEMINI.md`
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/JULES.md`

- [ ] **Step 10.1: Build dispatch prompt + capture fixtures**

```bash
cd /Volumes/WorkSSD/repos/personal/sirius-gateway
ls apps libs > /tmp/penumbra-dispatch/sirius-tree.txt 2>&1

cat > /tmp/penumbra-dispatch/sirius-agents-prompt.txt <<'EOF'
@nv-qwen3-coder-480b You are drafting an AGENTS.md for the sirius-gateway repo at /Volumes/WorkSSD/repos/personal/sirius-gateway. Attached: the EXAMPLE template (penumbra AGENTS.md), sirius-gateway's README.md, sirius-gateway's package.json, the apps/ + libs/ directory listing.
.
Produce ONE complete AGENTS.md. Match the EXAMPLE template's section structure EXACTLY (## Architecture, ## Quick reference, ## Conventions, ## MCP surface, ## Related fleet tools, ## Where to dig deeper). Length target: ~120 lines.
.
Non-negotiables:
.
- Conventional commits, NO AI / agent attribution in any examples
- "Architecture" must enumerate the apps and libs (sirius-api, sirius-mcp, provider-anthropic, provider-llamactl, provider-openai, sirius-auth, sirius-compat-openai, sirius-core, sirius-model-registry, sirius-observability, etc.) with one-line role descriptions
- "MCP surface" must describe the sirius-mcp app
- "Related fleet tools" must mention penumbra (penumbra has packages/integrations/sirius-middleware for fanning sirius traffic into its t0), llamactl (sirius-gateway has a provider-llamactl), and embersynth (TBD)
- Quick reference must include real bun/pnpm commands from the package.json scripts
.
Output ONLY the markdown content inside a single fenced code block, starting with `# sirius-gateway` (or whatever the repo's display name is per its README). No commentary outside the block.
.
done
EOF
```

- [ ] **Step 10.2: Dispatch**

```bash
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live \
bun /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/bin/agentchat.ts new --auto --max-hops 1 --transcript-budget 65536 \
  --attach /Volumes/WorkSSD/repos/personal/penumbra/AGENTS.md \
  --attach /Volumes/WorkSSD/repos/personal/sirius-gateway/README.md \
  --attach /Volumes/WorkSSD/repos/personal/sirius-gateway/package.json \
  --attach /tmp/penumbra-dispatch/sirius-tree.txt \
  < /tmp/penumbra-dispatch/sirius-agents-prompt.txt \
  > /tmp/penumbra-dispatch/sirius-agents-draft.log 2>&1
```

NVIDIA NIM has ~40 rpm rate limit; this is a single call (5 internal tasks), well within. If you batched multiple drafts close together, space them ≥10s apart.

- [ ] **Step 10.3: Extract the draft**

```bash
awk '/^```markdown$/,/^```$/' /tmp/penumbra-dispatch/sirius-agents-draft.log \
  | sed '1d;$d' \
  > /tmp/penumbra-dispatch/sirius-AGENTS-draft.md
wc -l /tmp/penumbra-dispatch/sirius-AGENTS-draft.md
```

If awk fails (different fence style), open the log and copy the markdown block by hand.

- [ ] **Step 10.4: Gate-check (same as Step 9.4) — verify all 6 sections present**

Visual review the draft against the same checklist as Task 9.4. Edit in place if minor; rewrite from template if major.

- [ ] **Step 10.5: Move into place + write pointer files**

```bash
cp /tmp/penumbra-dispatch/sirius-AGENTS-draft.md \
   /Volumes/WorkSSD/repos/personal/sirius-gateway/AGENTS.md

cat > /Volumes/WorkSSD/repos/personal/sirius-gateway/CLAUDE.md <<'EOF'
# sirius-gateway — Claude Code notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF

cat > /Volumes/WorkSSD/repos/personal/sirius-gateway/GEMINI.md <<'EOF'
# sirius-gateway — Gemini CLI notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF

cat > /Volumes/WorkSSD/repos/personal/sirius-gateway/JULES.md <<'EOF'
# sirius-gateway — Jules notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF
```

- [ ] **Step 10.6: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/sirius-gateway add AGENTS.md CLAUDE.md GEMINI.md JULES.md
git -C /Volumes/WorkSSD/repos/personal/sirius-gateway commit -m "docs: populate AGENTS.md (canonical) + Claude/Gemini/Jules pointers"
```

---

### Task 11: Draft + commit `embersynth/AGENTS.md`

**Files:**
- Modify: `/Volumes/WorkSSD/repos/personal/embersynth/AGENTS.md`
- Modify: `/Volumes/WorkSSD/repos/personal/embersynth/CLAUDE.md`
- Modify: `/Volumes/WorkSSD/repos/personal/embersynth/GEMINI.md`
- Modify: `/Volumes/WorkSSD/repos/personal/embersynth/JULES.md`

Dispatched to `@nv-llama4-maverick` — general frontier with strong format adherence. Length target: 60-80 lines (smaller surface).

- [ ] **Step 11.1: Build prompt + capture fixtures**

```bash
cd /Volumes/WorkSSD/repos/personal/embersynth
ls bin src config 2>/dev/null > /tmp/penumbra-dispatch/embersynth-tree.txt

cat > /tmp/penumbra-dispatch/embersynth-agents-prompt.txt <<'EOF'
@nv-llama4-maverick You are drafting an AGENTS.md for the embersynth repo at /Volumes/WorkSSD/repos/personal/embersynth. Attached: the EXAMPLE template (penumbra AGENTS.md), embersynth's README.md, embersynth's package.json, the bin/ + src/ + config/ directory listing.
.
Produce ONE complete AGENTS.md. Match the EXAMPLE template's section structure EXACTLY (## Architecture, ## Quick reference, ## Conventions, ## MCP surface, ## Related fleet tools, ## Where to dig deeper). Length target: 60-80 lines (smaller surface than penumbra/llamactl/sirius).
.
Non-negotiables:
.
- Conventional commits, NO AI / agent attribution in examples
- "MCP surface": if embersynth has no MCP server, write "embersynth does not currently expose an MCP server" and stop there. Do NOT invent tools.
- "Related fleet tools": penumbra (cross-agent chat / observation), llamactl (model orchestration), sirius-gateway (multi-provider OpenAI-compat gateway). One line each.
- Quick reference must use real commands from the package.json scripts.
.
Output ONLY the markdown content inside a single fenced code block. No commentary outside the block.
.
done
EOF
```

- [ ] **Step 11.2: Dispatch**

```bash
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live \
bun /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/bin/agentchat.ts new --auto --max-hops 1 --transcript-budget 32768 \
  --attach /Volumes/WorkSSD/repos/personal/penumbra/AGENTS.md \
  --attach /Volumes/WorkSSD/repos/personal/embersynth/README.md \
  --attach /Volumes/WorkSSD/repos/personal/embersynth/package.json \
  --attach /tmp/penumbra-dispatch/embersynth-tree.txt \
  < /tmp/penumbra-dispatch/embersynth-agents-prompt.txt \
  > /tmp/penumbra-dispatch/embersynth-agents-draft.log 2>&1
```

- [ ] **Step 11.3: Extract**

```bash
awk '/^```markdown$/,/^```$/' /tmp/penumbra-dispatch/embersynth-agents-draft.log \
  | sed '1d;$d' \
  > /tmp/penumbra-dispatch/embersynth-AGENTS-draft.md
wc -l /tmp/penumbra-dispatch/embersynth-AGENTS-draft.md
```

- [ ] **Step 11.4: Gate-check (same as Step 9.4)**

- [ ] **Step 11.5: Move into place + pointer files**

```bash
cp /tmp/penumbra-dispatch/embersynth-AGENTS-draft.md \
   /Volumes/WorkSSD/repos/personal/embersynth/AGENTS.md

cat > /Volumes/WorkSSD/repos/personal/embersynth/CLAUDE.md <<'EOF'
# embersynth — Claude Code notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF

cat > /Volumes/WorkSSD/repos/personal/embersynth/GEMINI.md <<'EOF'
# embersynth — Gemini CLI notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF

cat > /Volumes/WorkSSD/repos/personal/embersynth/JULES.md <<'EOF'
# embersynth — Jules notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).
EOF
```

- [ ] **Step 11.6: Commit**

```bash
git -C /Volumes/WorkSSD/repos/personal/embersynth add AGENTS.md CLAUDE.md GEMINI.md JULES.md
git -C /Volumes/WorkSSD/repos/personal/embersynth commit -m "docs: populate AGENTS.md (canonical) + Claude/Gemini/Jules pointers"
```

---

## Wave D — MCP wiring (3 user-level configs)

Each config gets the same set of MCP servers from `/tmp/penumbra-dispatch/mcp-recon.txt` (Task 1). The configs aren't in any git repo — they're user-level. After each edit, restart the corresponding harness to pick up the change.

### Task 12: Wire `~/.claude/settings.json`

**Files:**
- Modify: `/Users/acordeiro/.claude/settings.json`

- [ ] **Step 12.1: Back up existing settings**

```bash
cp /Users/acordeiro/.claude/settings.json /tmp/penumbra-dispatch/claude-settings.bak.json 2>/dev/null || echo "no existing settings.json — will create"
cat /Users/acordeiro/.claude/settings.json 2>/dev/null | head -40
```

- [ ] **Step 12.2: Inspect existing `mcpServers` section (if any)**

```bash
jq '.mcpServers // {}' /Users/acordeiro/.claude/settings.json 2>/dev/null
```

If `mcpServers` already has entries, merge — don't replace.

- [ ] **Step 12.3: Build the merged settings**

Use `jq` to merge new server entries into the existing JSON without losing other keys. Replace `<llamactl-launch>` and `<sirius-launch>` with the values recorded in `/tmp/penumbra-dispatch/mcp-recon.txt`. If embersynth was deferred in Task 1, omit its block.

```bash
# Construct the new mcpServers object (edit the placeholders!):
cat > /tmp/penumbra-dispatch/claude-mcp-additions.json <<'EOF'
{
  "penumbra": {
    "type": "stdio",
    "command": "bun",
    "args": ["/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts"],
    "env": { "PENUMBRA_STORAGE_ROOT": "/tmp/penumbra-live" }
  },
  "llamactl": {
    "type": "stdio",
    "command": "bun",
    "args": ["<absolute path to llamactl-mcp bin recorded in step 1.1>"]
  },
  "sirius": {
    "type": "stdio",
    "command": "bun",
    "args": ["<absolute path to sirius-mcp bin recorded in step 1.2>"]
  }
}
EOF

# Merge into the existing settings.json
jq --slurpfile add /tmp/penumbra-dispatch/claude-mcp-additions.json \
   '.mcpServers = ((.mcpServers // {}) + $add[0])' \
   /Users/acordeiro/.claude/settings.json \
   > /tmp/penumbra-dispatch/claude-settings.new.json

# Sanity check that the result is valid JSON and contains the new keys
jq '.mcpServers | keys' /tmp/penumbra-dispatch/claude-settings.new.json
```

Expected output: `["llamactl", "penumbra", "sirius", ...]` plus any pre-existing keys.

- [ ] **Step 12.4: Replace the live file**

```bash
mv /tmp/penumbra-dispatch/claude-settings.new.json /Users/acordeiro/.claude/settings.json
```

- [ ] **Step 12.5: Restart Claude Code and verify**

Restart your Claude Code session. Then in a new session anywhere on the filesystem (e.g. `cd /tmp && claude`), check that the MCP tools are listed:

```
/mcp
```

Expected: penumbra-mcp, llamactl-mcp, sirius-mcp all appear with their tool counts. If a server fails to connect, the `/mcp` panel shows an error — fix the `command` / `args` / `env` and reload.

If something goes wrong: `cp /tmp/penumbra-dispatch/claude-settings.bak.json /Users/acordeiro/.claude/settings.json` to restore.

---

### Task 13: Wire `~/.gemini/settings.json`

**Files:**
- Modify: `/Users/acordeiro/.gemini/settings.json`

Same shape as Claude (Gemini also uses a `mcpServers` JSON map).

- [ ] **Step 13.1: Back up + inspect**

```bash
ls /Users/acordeiro/.gemini/settings.json 2>/dev/null
cp /Users/acordeiro/.gemini/settings.json /tmp/penumbra-dispatch/gemini-settings.bak.json 2>/dev/null \
   || echo "no existing settings.json — will create"
jq '.mcpServers // {}' /Users/acordeiro/.gemini/settings.json 2>/dev/null
```

If `~/.gemini/` doesn't exist, create it: `mkdir -p ~/.gemini`.

- [ ] **Step 13.2: Merge in the same MCP entries**

```bash
# Reuse claude-mcp-additions.json from Task 12
jq --slurpfile add /tmp/penumbra-dispatch/claude-mcp-additions.json \
   '.mcpServers = ((.mcpServers // {}) + $add[0])' \
   /Users/acordeiro/.gemini/settings.json \
   > /tmp/penumbra-dispatch/gemini-settings.new.json 2>/dev/null \
   || jq --slurpfile add /tmp/penumbra-dispatch/claude-mcp-additions.json \
        '{mcpServers: $add[0]}' \
        --null-input \
        > /tmp/penumbra-dispatch/gemini-settings.new.json

jq '.mcpServers | keys' /tmp/penumbra-dispatch/gemini-settings.new.json
```

The fallback `jq --null-input '{mcpServers: $add[0]}'` handles the case where `~/.gemini/settings.json` doesn't exist or is empty.

- [ ] **Step 13.3: Replace + verify**

```bash
mv /tmp/penumbra-dispatch/gemini-settings.new.json /Users/acordeiro/.gemini/settings.json
```

Restart any running Gemini CLI session. In a new session run `/mcp` (or Gemini's equivalent — `gemini --help | grep -i mcp` to find the listing command if `/mcp` isn't it).

---

### Task 14: Wire `~/.codex/config.toml`

**Files:**
- Modify: `/Users/acordeiro/.codex/config.toml`

Codex uses TOML. The MCP entries are `[mcp_servers.<name>]` sections.

- [ ] **Step 14.1: Back up + inspect**

```bash
ls /Users/acordeiro/.codex/config.toml 2>/dev/null
cp /Users/acordeiro/.codex/config.toml /tmp/penumbra-dispatch/codex-config.bak.toml 2>/dev/null \
   || echo "no existing config.toml — will create"
grep -A 20 "^\[mcp_servers" /Users/acordeiro/.codex/config.toml 2>/dev/null | head -30
```

- [ ] **Step 14.2: Append the TOML entries**

Replace `<llamactl-bin>` and `<sirius-bin>` with the absolute paths from `/tmp/penumbra-dispatch/mcp-recon.txt`. Append (don't replace — the existing file may have non-MCP entries you must keep).

```bash
mkdir -p /Users/acordeiro/.codex

cat >> /Users/acordeiro/.codex/config.toml <<'EOF'

[mcp_servers.penumbra]
command = "bun"
args = ["/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts"]

[mcp_servers.penumbra.env]
PENUMBRA_STORAGE_ROOT = "/tmp/penumbra-live"

[mcp_servers.llamactl]
command = "bun"
args = ["<llamactl-bin>"]

[mcp_servers.sirius]
command = "bun"
args = ["<sirius-bin>"]
EOF
```

- [ ] **Step 14.3: Validate TOML**

```bash
# Quick TOML syntax check via a tiny python one-liner (Python 3.11+ has tomllib)
python3 -c "import tomllib; tomllib.load(open('/Users/acordeiro/.codex/config.toml','rb')); print('OK')"
```

Expected: `OK`. If it errors with `TOMLDecodeError`, fix the syntax before continuing.

- [ ] **Step 14.4: Verify in Codex**

Restart any running Codex CLI session. Confirm MCP tools register:

```
codex --help | grep -i mcp
```

Or run a session and look for the MCP-tools listing in the start-up info. If Codex provides `/mcp` or similar, use that.

---

## Wave E — Manual smoke verification

### Task 15: Per-repo Q&A spot-check

For each of the 4 repos, fire up a fresh AI session and ask "what does this tool do? how do I run its tests?" — confirm AGENTS.md content surfaces.

- [ ] **Step 15.1: Penumbra**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra
claude  # or your harness of choice
# Then ask: "What does this tool do? How do I run its tests?"
```

Expected: response references `AGENTS.md` content (architecture overview, `bun test packages/...` commands).

- [ ] **Step 15.2: llamactl, sirius-gateway, embersynth — same drill**

For each, `cd` into the repo, fire up the AI session, ask the same question. Expected: each response is grounded in that repo's AGENTS.md.

- [ ] **Step 15.3: Cross-repo question**

In a session at `/tmp` (no project context):

> "How do I dispatch an agentchat chain to gemma 4 via NVIDIA NIM with a file attached?"

Expected: the response cites `agent-fleet.md` and `dispatch-examples.md` content. If the response says "I don't know — let me grep" instead, the wiring isn't reaching that session.

---

### Task 16: MCP listing verification across 3 harnesses

- [ ] **Step 16.1: Claude Code**

```bash
cd /tmp && claude
```

Run `/mcp`. Expected: penumbra, llamactl, sirius (and embersynth if non-deferred) all appear with non-zero tool counts.

- [ ] **Step 16.2: Gemini CLI**

```bash
cd /tmp && gemini
```

List MCP tools (command varies; `/mcp` or check the startup banner). Same expectation.

- [ ] **Step 16.3: Codex CLI**

```bash
cd /tmp && codex
```

List MCP tools. Same expectation.

If any harness fails to list a server: check the harness logs for the connection error, fix the bin path / env / args in the harness's config file, and retry. The `/tmp/penumbra-dispatch/<harness>-settings.bak.<ext>` backups are your rollback.

---

### Task 17: bench.ts parity check + final acceptance

- [ ] **Step 17.1: Run bench.ts against the locally-running model**

Make sure llama-server is up at `127.0.0.1:8080` (e.g., `llamactl server start gemma-4-26B-A4B-it-GGUF/...`).

```bash
bun /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/scripts/bench.ts \
  --label gemma4-26b \
  --url http://127.0.0.1:8080/v1 \
  --model local \
  | tee /tmp/penumbra-dispatch/bench-ts-gemma26.txt
```

Expected: 5 JSON lines. Each line has `task: "T4"|...|"T8"`, `answer: <string>`, `latencyMs: <number>`.

- [ ] **Step 17.2: Compare answers to the recorded bash run**

Spot-check that `bench.ts`'s output matches `bench-2-gemma26moe.txt` (the bash version's output) on the SAME questions:

```bash
# bash version (already recorded earlier in the session):
cat /tmp/penumbra-dispatch/bench2-gemma26moe.txt | grep -v '^---'
echo
# typescript version (just produced):
cat /tmp/penumbra-dispatch/bench-ts-gemma26.txt | jq -r '"\(.task): \(.answer)"'
```

Expected: same task IDs (T4..T8), semantically equivalent answers (exact match for T4/T6/T7/T8; T5 may differ slightly in prose but should still describe semaphoreWaiters + new conv lock acquisition).

- [ ] **Step 17.3: Final acceptance checklist**

Walk the spec's acceptance criteria (#1–#8) against reality:

- [ ] All 4 repos have `AGENTS.md` matching the Section 2 template (header structure correct, no placeholder content).
- [ ] All 4 repos have `CLAUDE.md`, `GEMINI.md`, `JULES.md` (3 lines or more, pointing at `AGENTS.md`).
- [ ] All 3 harness configs (`~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.codex/config.toml`) list penumbra/llamactl/sirius MCP entries (embersynth-mcp included if not deferred).
- [ ] Penumbra has `packages/agentchat/docs/{agent-fleet,dispatch-examples,openai-compat-keys}.md` and `packages/agentchat/scripts/bench.ts`.
- [ ] `bench.ts` test file passes (`bun test packages/agentchat/scripts/bench.test.ts`).
- [ ] Fresh Claude Code session in `/tmp` lists fleet MCP tools.
- [ ] Fresh Gemini CLI + Codex CLI sessions list fleet MCP tools.
- [ ] Spot-check Q&A in Step 15.3 surfaced `agent-fleet.md`/`dispatch-examples.md` content.

If any item fails, fix it directly (re-edit the relevant file, restart the harness). Don't open follow-up issues for in-scope items.

If embersynth-mcp was deferred in Task 1: open a follow-up note (e.g. add to `docs/superpowers/specs/2026-04-26-tooling-knowledge-distribution-design.md`'s "Open questions" section as `embersynth-mcp build TBD`) so the deferral is tracked.

- [ ] **Step 17.4: Final commit (if anything in penumbra was edited during smoke)**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra
git status
# If clean: nothing to commit. Otherwise:
# git add <files>
# git commit -m "docs(agentchat): smoke-test fixes from knowledge distribution rollout"
```

---

## Self-review

This plan was generated against `docs/superpowers/specs/2026-04-26-tooling-knowledge-distribution-design.md`. Coverage check:

- **Spec section "Architecture" (file tree)** → Task 2 (bench-prompts), Task 3 (bench.ts), Tasks 4-6 (the 3 cross-agent docs), Task 7 (penumbra AGENTS.md), Task 8 (penumbra pointers), Tasks 9-11 (other 3 repos AGENTS + pointers), Tasks 12-14 (3 harness configs).
- **Spec "Components"** — every artifact listed in the spec has a numbered task that produces it.
- **Spec "Build method (3 phases)"** → Wave B (phase 1: I author penumbra), Wave C (phase 2: fleet drafts), Wave E (phase 3: smoke). Wave A (recon) is a phase-0 prerequisite and Wave D (MCP wiring) sits between phase 1 and 3.
- **Spec "Acceptance criteria #1–8"** → Step 17.3 walks each one with an explicit checkbox.
- **No-AI-attribution + conventional commits** — every commit step uses a conventional-commits message with no AI/agent mentions.
- **Embersynth-mcp deferral** — Task 1 explicitly handles the absent case; Step 17.3 captures the deferral note.

No placeholder bullets ("TBD", "fill in", "similar to Task N"). The `<bin>` placeholders in Task 12-14 are explicitly tied to `/tmp/penumbra-dispatch/mcp-recon.txt` which Task 1 produces, with the engineer instructed to substitute.

Type/method names are consistent: `runBench(opts)` returns `BenchResult[]`, `BenchTask['id']` is `'T4'|'T5'|'T6'|'T7'|'T8'`, the `--attach`/`--auto`/`--max-hops` flags match agentchat's bin signature.
