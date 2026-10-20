# @penumbra/exec-primitives-consumer

Private test consumer for `@novaproto/exec-primitives@0.1.0`.

This package exact-pins the published registry release for decision 2031 and keeps the check out of Penumbra runtime code. It does not migrate `packages/agentchat`, and no package outside this test consumer imports `@novaproto/exec-primitives`.

This is a test consumer only; Penumbra runtime packages do not import the library (decision 2031).

Run the registry qualification re-run from the repository root:

```bash
bun packages/exec-primitives-consumer/scripts/registry-qualify.ts
bun packages/exec-primitives-consumer/scripts/registry-qualify.ts --write-evidence
```

The first command writes `tmp/exec-primitives-registry/run.json` only after all checks pass. The second command renders `docs/qualification/exec-primitives-0.1.0-registry-qualification.{json,md}` from that run.

Runner preconditions: clean worktree (exit 3 otherwise), local tag `qualification/sharedlib6-2026-09-24` and `f122106dc` as an ancestor of `HEAD` (exit 2 otherwise), an `origin/main` ref for the merge-base, and network access for the tarball and packument.
