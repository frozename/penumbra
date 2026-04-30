# cli-spawn adapters buffer stdout — implications for the maestro

**Discovered:** 2026-04-30, while attempting to dispatch the discord plan via codex-as-maestro. Two gemini-cli dispatches were cancelled by the maestro after ~5 min of no captured response, on the assumption they were wedged. Inspection of the worktrees showed they were genuinely empty: no commits, no diff. But the gemini *processes* had been running the whole time.

## Root cause

`packages/agentchat/src/adapters/cli-spawn.ts` uses `await new Response(proc.stdout).text()` to collect stdout. That's fully buffered — the worker sees nothing until the spawned CLI process exits cleanly. Three argv-mode adapters (`gemini-cli`, `claude-cli`, `codex-cli`) consume `cli-spawn` and inherit this behavior.

The `Adapter` interface has an optional `dispatchStream(): AsyncIterable<DispatchEvent>` method that yields deltas live. The streaming adapters implement it — `opencode-acp`, `openai-compat-http`, `stdio-acp`, `claude-acp-sonnet`. The cli-spawn adapters do not; they only implement the buffered `dispatch()` path.

So from the maestro's POV, a cli-spawn dispatch and a wedged-process state look identical: `chain_get_response` returns no responses, `chain_status` says `dispatched`, and the worktree is empty (because the agent hasn't begun emitting tool calls — it's still generating its prefix in stdout, which is being buffered).

## How to distinguish "buffered but working" from "actually wedged"

By adapter class, from `agentchat.yaml`:

| `adapter:` | Streaming? | Empty `chain_get_response` after 2min ⇒ |
|---|---|---|
| `openai-compat-http` | ✅ | likely wedged; investigate |
| `opencode-acp` | ✅ | likely wedged; investigate |
| `stdio-acp` (claude-acp) | ✅ | likely wedged; investigate |
| `gemini-cli` | ❌ buffered | normal — agent is probably working |
| `claude-cli` | ❌ buffered | normal — agent is probably working |
| `codex-cli` | ❌ buffered | normal — agent is probably working |
| `opencode-cli` | ❌ buffered | normal — agent is probably working |

For buffered adapters, use these signals instead of response-silence:

1. **`mcp__penumbra__worktree_inspect <handoff_id>`** — list files modified in the dispatch's worktree. If anything has changed, the agent is alive and editing. If empty *and* the wall-clock is within the buffered budget below, keep waiting.
2. **Process tree from the maestro's shell:** `pgrep -P $(pgrep -f agentchat-worker.ts) -l` — any non-zero list means the worker has active children doing work.
3. **Wall-clock budget by adapter and prompt size:**
   - 14KB+ prompt (e.g., a full plan): budget 5–15 min for gemini-cli, 10–30 min for claude-cli / codex-cli before considering wedged.
   - <2KB prompt (a quick reasoning task): budget 30–90s.

**Don't `chain.cancel` a buffered-adapter dispatch on response-silence alone.** Confirm wedge with at least one of the signals above first.

## Maestro prompt addendum (paste into next handoff)

> Adapter behavior matters when polling dispatch progress. Streaming adapters (openai-compat-http, opencode-acp, stdio-acp, claude-acp-sonnet) yield deltas live — empty `chain_get_response` after 2 min IS a wedge signal. Buffered adapters (gemini-cli, claude-cli, codex-cli, opencode-cli) emit nothing through `chain_get_response` until the underlying process exits — empty response is NOT a wedge signal. For buffered adapters, confirm wedge via `mcp__penumbra__worktree_inspect` (look for file activity) or `pgrep -P $(pgrep -f agentchat-worker.ts)` (look for child processes) before calling `chain.cancel`. Budget 5–15 min for gemini-cli on plan-sized prompts, 10–30 min for claude-cli / codex-cli.

## The fix

The buffered behavior is itself a bug — adapters that wrap CLI tools that DO stream their output (claude with `--print` streams; codex with `--yolo` streams) shouldn't have to buffer. The `cli-spawn` helper should support a streaming mode that yields stdout chunks as they arrive, and the cli-spawn adapters should implement `dispatchStream` against it.

Plan: `docs/superpowers/plans/2026-04-30-cli-spawn-streaming.md`. Until it ships, the addendum above keeps maestros from cancelling working dispatches.
