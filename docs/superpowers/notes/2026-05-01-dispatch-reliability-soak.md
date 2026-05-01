# Dispatch Reliability Soak

**Start:** 2026-05-01
**Scope:** Penumbra dispatch and delegated agent reliability.

## Daily Checks

- Run `bun packages/agentchat/scripts/reliability-smoke/run.ts`.
- Run `bun typecheck`.
- For every failed or cancelled handoff, run `penumbra dispatch audit <handoff_id> --json`.
- Record any `timeline_inconsistent`, `watchdog_only`, `cancel_completed`, or `agent_declared_done_unverified` result.

## Promotion Policy

- Prefer an agent for a role after 5 task-specific trusted successes.
- Use ranked-first routing after 10 task-specific rows with high trust score.
- Quarantine an agent for a task type after repeated empty output, unverifiable completion, fabricated evidence, or watchdog-only failures.
- Mark environment failures separately from model quality failures.

## Results

| Date | Handoff | Agent | Task type | Reliability status | Action | Notes |
|---|---|---|---|---|---|---|
