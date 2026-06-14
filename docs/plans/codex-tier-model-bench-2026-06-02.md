# codex-acp-deep tier — gpt model × reasoning bench

> Goal: empirically pick the most *balanced* gpt model + `reasoning_effort` to be the
> `codex-acp-deep` tier (deep coding reviewer + substantial implementer), replacing the
> removed `gpt-5.3-codex`. "Balanced" = highest coding quality within acceptable
> latency + subscription-token burn for a deep reviewer. Decided 2026-06-02:
> **real codex-CLI path**, **full 12-config matrix**.

## Hard constraint (why not bench-2)
The codex agents run via the Codex CLI with **ChatGPT-subscription login auth** (`unsetEnv: [OPENAI_API_KEY,…]`, no API key wired). penumbra's `bench-2` (`packages/agentchat/scripts/bench.ts`) is **HTTP-only** (`fetch` + Bearer token; `bench-fleet.ts` filters to `adapter === "openai-compat-http"`) so it cannot reach the codex-acp path, and its tasks are general-capability, not coding. The **`scripts/acp-promotion/`** harness *does* drive `codex-acp` end-to-end (chain_start → worktree → capture `latency_seconds`/reliability → grade) — but its 6 scenarios are capability smoke (ping/read/write/terminal/lenient-review/deny). So we bench through acp-promotion, **extended with quality-discriminating coding scenarios**.

## Candidate matrix (12)
`{gpt-5.5, gpt-5.4, gpt-5.2, gpt-5.4-mini} × {low, medium, high}` reasoning_effort.
All four base models are ChatGPT-auth-available (each already used elsewhere via the codex CLI: @codex=5.4, @codex-frontier=5.2, @codex-mini=5.4-mini, codex-acp-deep=5.5). The `-codex`-tagged tiers (gpt-5.3-codex etc.) are excluded — they require `codex login --api-key`, which isn't wired.

Baselines for reference rows: current `codex-acp-deep` (gpt-5.5 high), `claude-acp-sonnet`.

## Prerequisite (gating)
1. **Phase 7 lands** (routing-balance code — in flight on gemini-acp-pro).
2. **Activation kickstart** — restarts the daemon/workers so codex works again (the gpt-5.5 re-pin + worker config), activates the landed hot-reload (5cf0d210), and loads the bench variants. Until then `codex-acp` is down (workers cached the removed gpt-5.3-codex). Checkpoint with operator before the restart.

## Steps
1. **Add 12 bench-candidate variants** to `~/.config/agentchat/agentchat.yaml`: clones of the `codex-acp` block with `-c model="<m>" -c model_reasoning_effort="<r>"`, `roles: []`, `tags: [bench-candidate]` (quarantined from routing). Reload to validate parse; the kickstart loads them into workers.
2. **Extend the harness** (`scripts/acp-promotion/scenarios.ts` + `evaluate.ts`, dispatched as a code task) with 2–3 *discriminating* coding scenarios, graded deterministically where possible:
   - **subtle-bug review** — a file/diff with one planted concrete bug (off-by-one / missing null / race); "find the bug or reply NO_FINDINGS." Grade: found THE bug (substring/keyword check) vs miss vs false-positive.
   - **implement-against-failing-test** — a well-scoped function + a failing test in the worktree; "make it pass." Grade: `bun test <file>` passes (deterministic).
   - **concurrency-reasoning** — reuse bench-2 T5 (semaphore+lock under contention) as a codex-CLI prompt; judge-graded PASS/PARTIAL/FAIL.
3. **Run** `runAcpPromotion({ agents: [12 variants], baselines: [codex-acp-deep, claude-acp-sonnet], scenarios: [coding set], live: true })`. Captures per-config verdicts + `latency_seconds` + reliability; pull token usage from the dispatch timeline (subscription-burn proxy).
4. **Rank by balance**: quality pass-rate (primary) → median latency + total tokens (secondary). Frontier pick = highest quality within acceptable latency/burn for a deep reviewer (not necessarily the absolute top if a cheaper/faster config matches quality).
5. **Re-pin** `codex-acp-deep` to the winner (`model` + `model_reasoning_effort`); `daemon_reload_config` (now hot-reloads to workers post-5cf0d210, no restart). Retire the bench variants (delete or tag `deprecated`). Record results in `packages/agentchat/docs/agent-fleet.md` + update the `gpt-5.5` tags.

## Cost note
12 configs × ~3 coding scenarios = ~36 codex dispatches (+ baselines), each minutes of wall time + subscription tokens. Operator chose the full matrix knowingly. Could trim to a focused subset (gpt-5.5 {med,high}, gpt-5.4 {high}, gpt-5.4-mini {med}) if burn matters.
