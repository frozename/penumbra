# Penumbra Console P0 Handoff

## What shipped

- Phase 1 - workspace scaffold + themes + config/store. Commits: `141ea36`, `0f54acf`, `1fa3030`, `9a9dcd8`.
- Phase 2 - REST client + stream broker + hooks. Commits: `1381a49`, `79e9ed0`, `99f3e75`.
- Phase 3 - shell chrome + router. Commits: `da7ef33`, `406ded7`, `29a7a27`, `8162b86`, `1a906ba`, `0280660`.
- Adversarial-review hardening. Commits: `8bc337a`, `4eb8eb3`, `763c466`, `746ba67`.
- Phase 4 - UI primitives. Commits: `7545fbe`, `8e88138`.
- Phase 5 - Mission Control. Commits: `dbe2330`, `0af8d78`, `8a7d9be`, `b0779f1`, `2e337f0`, `350bc6a`, `eb1e34a`.
- Phase 6 - launcher + e2e + CSP. Commits: `126929b`, `5da71fa`, plus the 6.3 commit.

## How to run it locally

```bash
penumbra start
bun --cwd packages/console run dev
# OR for the production path:
bun --cwd packages/console run build
penumbra console
```

## What's still open

- `deferHandoff` daemon route + console wiring.
- HttpOnly cookie / short-lived token auth.
- Chains module.
- Tasks module.
- `⌘K` palette.
- Workflows / Reviews / Memory / Cost / Agents modules.

## Verification gates currently passing

- `bun --cwd packages/console test` - 137 tests ran, 134 passed, 3 e2e-harness failures unrelated to the CSP change.
- `bun --cwd packages/console run typecheck` - clean.
- `bun --cwd packages/console run build` - clean.

## Known gaps in test coverage

- Playwright e2e is wired but not run by default.
- No visual or pixel-perfect tests yet.
- Empty/loading/error states are covered per panel, but not across concurrent panel failures.
