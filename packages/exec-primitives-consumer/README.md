# @penumbra/exec-primitives-consumer

Private test consumer for `@novaproto/exec-primitives@0.1.0`.

This package exact-pins the published registry release for decision 2031 and keeps the check out of Penumbra runtime code. It does not migrate `packages/agentchat`, and no package outside this test consumer imports `@novaproto/exec-primitives`.

Run the registry qualification re-run from the repository root:

```bash
bun packages/exec-primitives-consumer/scripts/registry-qualify.ts
bun packages/exec-primitives-consumer/scripts/registry-qualify.ts --write-evidence
```

The first command writes `tmp/exec-primitives-registry/run.json` only after all checks pass. The second command renders `docs/qualification/exec-primitives-0.1.0-registry-qualification.{json,md}` from that run.
