# Memory Verify Authz Decouple

- Phase 4 complete: lane close is now locked as pure state recording, and the regression test covers unset, `1`, and `0` values for `PENUMBRA_MEMORY_VERIFY_AUTO_FIRE`.
- Phase 5 complete: the dead auto-fire path has been removed, so `/memory-verify/authorize` is now the sole verification writer.
