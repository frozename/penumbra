# Interrupted live observer

This attempt is **interrupted and unexercised**. The observer stopped on stale guard telemetry after 659.3 seconds, before any new eligible P1 case or candidate request. The outer lifecycle erroneously retained`aborted=false`; do not treat that field or exit 0 as a pass. [analysis.json](analysis.json) records the corrected outcome while preserving original evidence.

The later [guarded historical replay](../system-one-judges-2026-11-12-guarded-replay/analysis.json) separates critical telemetry from slow diagnostics and explicitly classifies observer termination. It remains partial historical evidence, not a passing live-production trial. No production authority was activated and no retry/filter policy was reset to create work.

Scripts are one-run, hardware-specific execution records with explicit`--live`. Old outputs must not be overwritten. Raw historical input text is absent; only hashes, IDs and typed ballot fields are retained. The extraction-input audit is read-only source analysis and does not change production evidence windows.
