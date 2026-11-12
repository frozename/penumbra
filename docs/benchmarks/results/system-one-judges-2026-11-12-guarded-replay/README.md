# Guarded replay evidence

This historical operational replay is **partial**, not a passing live-shadow gate:20 selected, 18 attempted, 17 answered,one timeout,two unattempted within the900-second admission window. The [analysis](analysis.json) separates request, resource and historical-ballot evidence. Model quality labels are not supplied. Both disagreement cases match negative labels in the earlier independently AI-reviewed development corpus; they are reused cases, not new acceptance evidence.

The critical sensor is independent from slow GPU/RSS sampling. Thirteen guard regression tests pass. The actual timeout also exposed a production-source diagnostic race; a new regression first failed, then the fix passed 47 focused tests and full CI:7 blocking passes, 0 failures, 4 skips, 16,677 passing test executions including repeated coverage. See [regression validation](regression-validation.json) and [CI attestation](ci-validation.json).

The [post-CI service state](final-runtime-status.json) and [configured-factory smoke](post-ci-granite-smoke.json) verify restoration after the authorized idle Granite pause. The source fix is prepared in the branch; deployed daemon source and native authority remain unchanged/off. No other inference service was restarted.

Offline verification, from repository root:

```sh
R=docs/benchmarks/results/system-one-judges-2026-11-12-guarded-replay
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$R" -p guard_test.py
python3 "$R/analyze.py"
```

`run-replay.py` and `check-ci.py` are hardware-specific one-run execution records, not general deployment commands. They require explicit `--live`; the CI driver must hold the existing heavy-job lock and pauses the user-authorized Granite service. Do not overwrite old output directories or rerun service operations without current idle/capacity checks. Raw test logs and original review rationales remain private. The preceding [live attempt](../system-one-judges-2026-11-12-live-shadow/analysis.json) had zero candidate exposure and was interrupted; it is not a passing run.
