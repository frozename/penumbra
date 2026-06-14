# Bun Rust canary pilot — 2026-05-15

## Context

Bun PR #30412 (Zig→Rust rewrite, 6,755 commits, ~1M LOC) merged into `main` on 2026-05-14. Available on the rolling `canary` tag, accessed via `bun upgrade --canary`. Stated goal: memory safety via Rust's compiler. v1.3.14 will be the final Zig release; the Rust port is canary-only for now.

## Phase 0 — install (✓)

Installed canary to an isolated prefix, leaving `~/.bun/bin/bun` (1.3.13 Zig) untouched:

```bash
mkdir -p ~/.bun-canary/bin
curl -fsSL -o /tmp/bun-canary.zip 'https://github.com/oven-sh/bun/releases/download/canary/bun-darwin-aarch64.zip'
unzip -oq /tmp/bun-canary.zip -d /tmp
mv /tmp/bun-darwin-aarch64/bun ~/.bun-canary/bin/bun
chmod +x ~/.bun-canary/bin/bun
```

Result: `1.3.14-canary.1+4d443e540`.

**Do NOT use `bun upgrade --canary`** — it overwrites `~/.bun/bin/bun`, which is the binary the daemon and worker run. Side-by-side install is the only safe pilot path.

## Phase 1 — smoke test parity (✓)

Ran the workspace test matrix on both runtimes from the home checkout (HEAD `64a5a9e`). Typecheck identical (clean). Pass/fail breakdown:

| Package | Stable 1.3.13 | Canary 1.3.14 | Verdict |
|---|---|---|---|
| mcp | 294/0 | 294/0 | parity |
| core | 764/27 | 764/27 | parity, 27 pre-existing failures |
| daemon | 670/40 in 710 | 683/39 in 722 | within run-to-run variance (±15 tests) |
| agentchat | 1509/30 (+4 skip) | 1509/30 (+4 skip) | parity |
| cli | 195/0 | 195/0 | parity |

Aggregate: ~3,430 tests across 491 files, **zero regressions** introduced by canary. Wall time marginally faster on canary (~1–3%). The `bun_onnx_teardown_panic` (memory: cosmetic C++ teardown crash via fastembed/ONNX) still surfaces on both — not a canary issue.

The daemon test-count delta initially looked like a discovery difference but variance testing (3× stable: 701/717; 2× canary: 707/723) put both within the same noise floor. The suite is timing-sensitive.

#30717 (canary `bun:ffi` `dlopen()` regression for embedded `with: { type: "file" }` libraries inside `bun build --compile` output) doesn't affect us — zero direct `bun:ffi` imports in the workspace.

## Phase 2 — launchd swap (BLOCKED, not by canary)

Snapshot of stable plist saved as `~/Library/LaunchAgents/dev.penumbra.worker.plist.bak.stable-1.3.13`.

Swapped the worker plist's `ProgramArguments[0]` and PATH prefix to `~/.bun-canary/bin/bun`. `launchctl bootout` then `launchctl bootstrap`. New worker process spawned with the canary binary.

**The new worker hangs at boot — but so does stable bun under launchd from this point on.** sample(1) shows the process pinned in `__private_getcwd → __open_nocancel`:

```
2300 Thread_156386   DispatchQueue_1: com.apple.main-thread  (serial)
  2300 start (in dyld) + 6992
    2300 ??? (in bun)
      ... bun runtime init
        2300 __private_getcwd (in libsystem_c.dylib) + 184
          2300 __getcwd (in libsystem_c.dylib) + 76
            2300 open$NOCANCEL (in libsystem_kernel.dylib) + 64
              2300 __open_nocancel (in libsystem_kernel.dylib) + 8
```

After ~10 cycles of bootout+bootstrap, every newly-launchd-spawned bun process (canary OR stable) sits at this stack frame for 90s+ without progressing. RSS stays at 2848–2960 KB; no source files load, no sockets open, no FDs beyond stdin/stdout/stderr. State `S` (sleeping) the whole time. KeepAlive respawns inherit the same hang.

The same `bun --version` invoked from my interactive shell with the launchd env emulated (`env -i`, same `PATH`/`HOME`/`XPC_SERVICE_NAME`) returns instantly. The volume `/Volumes/WorkSSD` responds to `stat` from the shell in ~4ms. So the problem is specifically the launchd-spawned-child-process path resolving `getcwd()` against a `WorkingDirectory` on the external SSD.

The daemon (PID 1471, also on stable bun, also with `WorkingDirectory=/Volumes/WorkSSD/repos/personal/penumbra`) is unaffected — it's been alive ~50 min through the whole pilot. The hang only appears for newly-spawned children under this launchd service since the bootout/bootstrap cycling began.

**Root cause (identified after further probing):** macOS TCC. The `launchctl bootout` + `bootstrap` cycle registers a NEW service in launchd's domain, which breaks the FDA inheritance that natural KeepAlive respawns preserve. Subsequent spawns are subjected to fresh TCC checks; `/Volumes/*` is gated as "Removable Volumes" and EPERM was being returned from `open(2)` but presented as a hang because the consent prompt fired into a UI-less context. A bash-shim probe (`ls /Volumes/WorkSSD/repos/personal/penumbra`) returned `Operation not permitted` instantly — proving the hang was a stalled consent prompt, not a kernel deadlock.

## Resolution

**No reboot was needed.** Recovery path that worked:

1. Open System Settings → Privacy & Security → Full Disk Access.
2. Click `+`, navigate via Cmd+Shift+G to `/Users/acordeiro/.bun/bin/bun`, add it, toggle on.
3. `launchctl bootout gui/$UID/dev.penumbra.worker && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.penumbra.worker.plist`.

Worker booted as `worker-uwus9` at 21:04:28Z, RSS 138 MB (vs 2.9 MB when TCC-blocked), sockets listening, usage-poller alive, connected to daemon on port 51257.

## Current state

- Worker plist (on disk): **stable bun**, original `ProgramArguments` + `WorkingDirectory`. Backup at `~/Library/LaunchAgents/dev.penumbra.worker.plist.bak.stable-1.3.13`.
- Worker service: **running** on stable 1.3.13.
- Daemon: alive and healthy (PID 1471).
- Bun canary: still installed side-by-side at `~/.bun-canary/bin/bun` for future Phase 2 attempts.

## Phase 2 — worker swap (✓, retried same session after TCC fix)

After granting FDA to `/Users/acordeiro/.bun-canary/bin/bun`:

1. Snapshotted current plist to `.bak.pre-canary` (matched the `.bak.stable-1.3.13` snapshot byte-for-byte — confirmed clean baseline).
2. Edited plist: `ProgramArguments[0]` swapped to `~/.bun-canary/bin/bun`, prepended `~/.bun-canary/bin:` to PATH.
3. Single `launchctl bootout`+`bootstrap` of `dev.penumbra.worker`.

Result: worker `worker-vjw1l` booted at 21:10:56Z on canary. PID 59615, RSS 111 MB at boot → 146 MB after the smoke dispatch.

Smoke validation: dispatched `chain_start` to `codex-acp-fast` with task_class=TRIVIAL, max_hops=2, use_worktree=false, message asking for the literal echo `"canary worker round-trip OK"`. Result:

- chain_wait completed in **7s**
- response exactly `"canary worker round-trip OK"` — no garble, no extra text
- Worker stderr clean post-dispatch; no panics, no segfaults

Full dispatch path validated under canary: MCP → daemon → canary-bun worker → ACP agent spawn → response → chain_wait/get_response.

Long-lived tick smoke not run: `home-mgmt` is paused with a pending HA-diagnosis goal that would auto-dispatch on resume. Skipped to avoid side-effects; same dispatch path is exercised by the `chain_start` smoke.

## Phase 3 — daemon swap (✓, same session after worker validated)

Daemon plist (`dev.penumbra.daemon`) is structurally identical to the worker's: same bun binary, same WorkingDirectory on `/Volumes/WorkSSD/repos/personal/penumbra`, same KeepAlive policy.

Snapshot taken at `~/Library/LaunchAgents/dev.penumbra.daemon.plist.bak.stable-1.3.13` (byte-identical to pre-edit). Edited `ProgramArguments[0]` and prepended `~/.bun-canary/bin:` to PATH. Single `launchctl bootout`+`bootstrap`.

Result: daemon PID 62905 on canary, port 51257 LISTEN, `GET /health` returns `{"status":"ok","version":"0.0.0"}` immediately. Worker hit the expected SSE disconnect at 21:15:53 (`"socket connection was closed unexpectedly"`, `"control listener stream error; reconnecting in 5s"`), then reconnected silently once the daemon came up at 21:15:58.

End-to-end smoke under canary daemon + canary worker: dispatched `chain_start` to `codex-acp-fast` requesting echo of `"canary daemon+worker round-trip OK"`. Result completed in 10s, exact-match response.

## Final state — canary on the full penumbra stack

- Daemon: PID 62905, RSS 471 MB, `/Users/acordeiro/.bun-canary/bin/bun`
- Worker: PID 59615, RSS 171 MB, `/Users/acordeiro/.bun-canary/bin/bun`
- Both healthy, port 51257 LISTEN, smoke dispatches green
- Stable backups available:
  - `~/Library/LaunchAgents/dev.penumbra.daemon.plist.bak.stable-1.3.13`
  - `~/Library/LaunchAgents/dev.penumbra.worker.plist.bak.stable-1.3.13`
- Rollback path: `cp` the `.bak.stable-1.3.13` file over the live plist, `launchctl bootout` + `bootstrap`. Single cycle each.
- Stable bun (1.3.13) still present at `~/.bun/bin/bun` for the rollback.

## Resuming Phase 2 later

Now that bun has Full Disk Access, the bootout+bootstrap cycle should preserve TCC. To retry Phase 2:

1. Edit `~/Library/LaunchAgents/dev.penumbra.worker.plist`: swap `/Users/acordeiro/.bun/bin/bun` → `/Users/acordeiro/.bun-canary/bin/bun` in `ProgramArguments[0]`, prepend `/Users/acordeiro/.bun-canary/bin:` to PATH.
2. If canary needs its OWN FDA grant (likely, since it's a different cdhash), add `/Users/acordeiro/.bun-canary/bin/bun` to Full Disk Access first.
3. `launchctl bootout gui/$UID/dev.penumbra.worker && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.penumbra.worker.plist`. ONCE.
4. Verify worker boots with RSS ≥130 MB and emits the startup line. Watch one home-mgmt tick and one `chain_start` round-trip.
5. To roll back: restore `dev.penumbra.worker.plist.bak.stable-1.3.13`, bootout+bootstrap.

If you want to skip Phase 2 entirely: Phase 1 is conclusive on its own. Canary is functionally equivalent to stable across all test surfaces with no regressions. Whenever the next non-canary 1.4.0 release lands, our workspace should adopt it cleanly.

## Recommendation

Phase 1 already gives us the signal we needed: canary won't break the workspace. Phase 2 was the gold-standard live-traffic confirmation; we don't have it because of the launchd-cold-boot quirk, not because of canary.

Defer Phase 2 to a session that begins right after a fresh boot — that gives a clean launchd state for the swap and rollback paths. Mark this pilot ✓ on the runtime question, ⏸ on the live-traffic question.
