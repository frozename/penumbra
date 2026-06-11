# T2 Crash Repro Evidence - 2026-06-11

## Harness

Command:

```bash
~/.bun/bin/bun scripts/t2-crash-repro.ts
```

The parent process spawned `scripts/t2-crash-repro.ts --tick` three times under each runtime. Each child copied `~/.penumbra/db.sqlite` and present sidecars into a fresh temp directory before opening SQLite, then attempted one T2 promotion rollup against a direct `createJudgePool` judge entry:

```json
{"name":"repro-proxy","baseUrl":"http://127.0.0.1:7944/v1","apiKey":"local-no-auth","model":"granite-mini-3b"}
```

## Run Matrix

| runtime | version | exit | signal | outcome | duration_ms |
| --- | --- | ---: | --- | --- | ---: |
| `/Users/acordeiro/.bun-canary/bin/bun` | 1.3.14 | 1 | null | judge_failed | 2777 |
| `/Users/acordeiro/.bun-canary/bin/bun` | 1.3.14 | 1 | null | judge_failed | 2772 |
| `/Users/acordeiro/.bun-canary/bin/bun` | 1.3.14 | 1 | null | judge_failed | 2820 |
| `/Users/acordeiro/.bun/bin/bun` | 1.4.0 | 1 | null | judge_failed | 2830 |
| `/Users/acordeiro/.bun/bin/bun` | 1.4.0 | 1 | null | judge_failed | 2816 |
| `/Users/acordeiro/.bun/bin/bun` | 1.4.0 | 1 | null | judge_failed | 2788 |

Raw parent summary:

```json
{"runs":[{"runtime_binary":"/Users/acordeiro/.bun-canary/bin/bun","bun_version":"1.3.14","exit_code":1,"signal":null,"outcome":"judge_failed","duration_ms":2777},{"runtime_binary":"/Users/acordeiro/.bun-canary/bin/bun","bun_version":"1.3.14","exit_code":1,"signal":null,"outcome":"judge_failed","duration_ms":2772},{"runtime_binary":"/Users/acordeiro/.bun-canary/bin/bun","bun_version":"1.3.14","exit_code":1,"signal":null,"outcome":"judge_failed","duration_ms":2820},{"runtime_binary":"/Users/acordeiro/.bun/bin/bun","bun_version":"1.4.0","exit_code":1,"signal":null,"outcome":"judge_failed","duration_ms":2830},{"runtime_binary":"/Users/acordeiro/.bun/bin/bun","bun_version":"1.4.0","exit_code":1,"signal":null,"outcome":"judge_failed","duration_ms":2816},{"runtime_binary":"/Users/acordeiro/.bun/bin/bun","bun_version":"1.4.0","exit_code":1,"signal":null,"outcome":"judge_failed","duration_ms":2788}]}
```

## Verdict

This run did not reproduce the Bun canary segfault. Both canary and stable reached the T2 promotion path and exited through a caught JavaScript judge failure. No child exited by signal, and no run produced a crash outcome.

The matrix is therefore inconclusive for canary-vs-stable crash attribution in this environment because the configured repro judge endpoint returned a connection-level failure before the promotion path could complete. A debug child run showed the failing component as the judge HTTP request from `createJudgePool`:

```text
Error: Was there a typo in the url or port?
```

## Stub Embed Bisect

Skipped. The canary crash did not reproduce in the baseline matrix, so there was no crashing leg to bisect with `--stub-embed`.
