# Fleet Hygiene Snapshot (2026-04-27)

## Handoff queue
- Pending: 0
- Stuck pending (>30min): None
- Status breakdown:
    - `completed`: 152
    - `failed`: 107
    - `expired`: 13
    - `dispatched`: 5 (active)
    - `rejected`: 5

## Failure rate analysis (last 3 hours)
- High failure rate observed in recent rounds of ACP vendor protocol tests.
- Top error patterns:
    - `worker timeout`: Watchdog-triggered failure due to worker non-responsiveness.
    - `unknown adapter kind: opencode-acp`: Regression in adapter registry (since fixed).
    - `HTTP 500`: OpenCode ACP server boot/event subscription failures.
    - `JSON-RPC -32602`: Parameter mismatch in stdio-ACP vendors.

## Worktree cleanup candidates
- Total directories under `/Volumes/WorkSSD/repos/penumbra-worktrees/`: 51 (excluding `nova`)
- Of those, terminal-handoff (safe to clean): 46
    - Examples: `04faf0da`, `1e24a162`, `1f90385c`, `26b1fbae`, `31f5a2ac`.
- Active (do NOT touch): 5
    - `603d3b02`, `119e36f8`, `58096826`, `cbdc49d3`, `c27be300` (current session).

## Worker fleet
- Active workers (based on recent heartbeats and dispatched tasks):
    - `worker-primary` (Active)
    - `worker-d` (Active)
    - `worker-b` (Active)
- Watchdog interval: 15s check, 60s timeout.

## Verdict
- **Healthy (Minor anomalies)** — The handoff queue is moving efficiently with no pending or stale dispatched tasks. However, significant worktree accumulation (46 terminal directories) is present and warrants a manual cleanup.

## Recommended cleanup actions
Run the following commands to remove terminal worktrees:
```bash
# Example for a batch of terminal worktrees
git worktree remove --force /Volumes/WorkSSD/repos/penumbra-worktrees/04faf0da-7a38-44ec-b4fa-e34cf68f3023
git worktree remove --force /Volumes/WorkSSD/repos/penumbra-worktrees/1e24a162-dfe9-4fc3-9109-8bd54b666c38
git worktree remove --force /Volumes/WorkSSD/repos/penumbra-worktrees/1f90385c-48a4-47f3-af2f-c6843064e2fc
# ... (repeat for all 46 terminal handoffs)
```
*Note: Use `git branch -D agent/<id>` to clean up associated branches.*
