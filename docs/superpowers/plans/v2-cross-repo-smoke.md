---
plan_id: v2-cross-repo-smoke
home_project: penumbra
plan_defaults:
  bounds:
    wall_clock_ms: 600000
    cost_cents: 50
    max_sub_dispatches: 3
---

# V2 Cross-Repo Smoke

Three-task plan that exercises the V2 V1 plan-runtime across two repos. Each task is a leaf `kind=orchestrate` task that the runtime files into the target project's task board when its deps are met.

## Phase 1 - Marker round-trip

Dispatch graph: `1.1 -> 1.2 -> 1.3`

### Task 1.1 - Add marker in penumbra

```yaml meta
id: '1.1'
project: penumbra
files:
  - packages/core/src/v2demo-marker.txt
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Create `packages/core/src/v2demo-marker.txt` with the single line `v2-demo-step-1`. Commit with message `chore: add v2demo marker`. Push.

### Task 1.2 - Add marker in sirius

```yaml meta
id: '1.2'
project: sirius
files:
  - v2demo-marker.txt
file_scope: new
depends_on: ['penumbra/1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Create `v2demo-marker.txt` at the sirius repo root with the single line `v2-demo-step-2`. Commit with message `chore: add v2demo marker`. Push.

### Task 1.3 - Remove marker in penumbra

```yaml meta
id: '1.3'
project: penumbra
files:
  - packages/core/src/v2demo-marker.txt
file_scope: extend-shared
depends_on: ['sirius/1.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Delete `packages/core/src/v2demo-marker.txt`. Commit with message `chore: remove v2demo marker`. Push.

Integration: after the runtime fires all three, both repos should have `chore: add v2demo marker` commits, and penumbra should have a follow-up `chore: remove v2demo marker` commit.
