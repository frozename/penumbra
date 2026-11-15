# Schema 47 to 49 cutover

Runbook for moving a live store from schema 47 to schema 49 (the self-hosted
judge adapter, covering index and rewriter repair build). Run it only inside an
idle window that the operator has approved. It changes the database and cannot
be undone by restarting the old binary.

What the first boot of a schema-49 build does inside `applySchema`:

| Step | Where | Cost on a large store |
| --- | --- | --- |
| `t1_promotion_eligible_lookup`, `t1_promotion_claim_lookup`, `idx_dream_actions_phase_status` (`CREATE INDEX IF NOT EXISTS`) | `ensureControlPlaneIndexes`, inside the `BEGIN..COMMIT` boot transaction | No-op when they already exist; a full build of `t1_rollups` otherwise |
| `dream_query_rewrites.policy_version TEXT NOT NULL DEFAULT 'legacy'` | after the boot transaction | Metadata-only `ALTER TABLE` |
| Lane-ledger open-row re-dedupe | `dedupeOpenLaneLedgerRowsOnce` (marker `lane_ledger_open_dedupe_schema_version`) | One `UPDATE` over open `lane_ledger` rows |
| `db_meta.schema_version = 49` | `migrate` | One-way (see step 4) |

The boot path does **not** build `idx_dispatch_events_activity_end_ts`. It is
the deferred activity index (`DEFERRED_ACTIVITY_INDEX_SQL` in
`packages/core/src/db/control-plane-indexes.ts`). `dispatch_events` is the
largest table, and building it inside the boot transaction would hold the write
lock with no deadline. The dreaming idle check already uses
`idx_dispatch_events_ts` without it. Step 6 builds it out of band under a
deadline. It is optional.

Placeholders used below:

```bash
ROOT="${PENUMBRA_STORAGE_ROOT:-$HOME/.penumbra}"   # holds db.sqlite, port and token
DB="$ROOT/db.sqlite"
BACKUP_DIR="$HOME/.penumbra/backups/schema-49-$(date -u +%Y%m%dT%H%M%SZ)"
REPO=/path/to/penumbra-49   # any checkout of the schema-49 build, used for read-only checks
LIVE=/path/to/penumbra      # the checkout the daemon and worker LaunchAgents run from
NEW_SHA=<full sha of the schema-49 build>
UID_=$(id -u)
```

`REPO` can be a separate worktree at `$NEW_SHA`. The `bun` snippets in steps 0, 3 and 6 only import
source from it. `LIVE` is not moved until step 7, after the services are
stopped.

## 0. Deploy prerequisites (before the window)

Set both of these in the daemon LaunchAgent environment
(`~/Library/LaunchAgents/dev.penumbra.daemon.plist`, `EnvironmentVariables`).
Edit the plist with `plutil`; do not hand-merge it.

1. **Keep P4 off.** Production runs `PENUMBRA_DREAMING_REWRITER_ENABLED=1`. With
   that flag set, the schema-49 build sends the R2 rewriter prompt to the live
   rewriter. The research verdict on that prompt is NO-GO (tag
   `research/system-one-judges-2026-11-14`). Add `P4` to
   `PENUMBRA_DREAMING_SKIP_PHASES`, keeping any phases already listed (for
   example `P4` or `P3,P4`).
2. **Point the inventory at the real registry.** Set
   `DEV_STORAGE=/Users/<you>/DevStorage`, or set `LLAMACTL_CONFIG` to the
   registry file. The new build resolves exactly one registry path, with no
   fallback chain: `LLAMACTL_CONFIG` if set, otherwise `$DEV_STORAGE/config` if
   `DEV_STORAGE` is set, otherwise `~/.llamactl/config`. It no longer defaults
   to `~/DevStorage/config`. If `DEV_STORAGE` is set but `$DEV_STORAGE/config`
   is missing, `~/.llamactl/config` is not tried. When the one resolved file is
   missing, the rewriter inventory comes back empty and every rewriter
   candidate is dropped (`abstaining from memory research`). `penumbra config
   sync-local` reads the same inventory, so run it with the same variables.

Also check, without printing the roster, that it loads and that every daemon
generation role resolves under the generation `maxTokens` cap (an integer from 1
to 16384). The roster schema accepts any integer `maxTokens`, because
dispatch-only seats share the option. The cap applies only to an
`openai-compat-http` seat that carries a generation role. When such a seat is
over the cap, the daemon refuses that role when it resolves it.

If the daemon plist overrides any of the `PENUMBRA_*_ROLE` variables below,
export the same values in this shell first.

```bash
cd "$REPO" && CONFIG_DIR="${PENUMBRA_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/penumbra}" bun -e '
import { loadAgentChatConfigFromDir } from "./packages/config/src/index.ts";
import { resolveRoleLlmCandidates } from "./packages/core/src/services/llm-candidates.ts";
const env = process.env;
const cfg = loadAgentChatConfigFromDir(env.CONFIG_DIR);
const roles = new Set([
  env.PENUMBRA_JUDGE_ROLE ?? "memory-refiner",
  env.PENUMBRA_T2_EXTRACTION_ROLE ?? env.PENUMBRA_JUDGE_ROLE ?? "memory-refiner",
  env.PENUMBRA_REFINER_ROLE ?? "refiner",
  env.PENUMBRA_DREAMING_JUDGE_ROLE ?? "dreaming-judge",
  env.PENUMBRA_DREAMING_REWRITER_ROLE ?? "dreaming-rewriter",
  env.PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE ?? "brief-synthesizer",
]);
let refused = 0;
for (const roleTag of roles) {
  try {
    const n = resolveRoleLlmCandidates({ roleTag, agentchatConfig: cfg }).length;
    console.log(`${roleTag}: ok (${n} seat(s))`);
  } catch (err) {
    refused += 1;
    console.log(`${roleTag}: REFUSED ${err.message}`);
  }
}
console.log(refused === 0 ? "roster ok" : "roster NOT ok");
process.exit(refused === 0 ? 0 : 1);'
```

It prints one line per role and counts seats, never seat options. It exits
non-zero on any failure:

- A schema failure throws before any role line:
  `<config dir>/agents.yaml: agents.N.<field>: <message>`, with the full path of
  the file.
- A role refusal prints `<role>: REFUSED agent "<name>" cannot serve generation
  role "<role>": options.maxTokens <n> is outside 1 to 16384 (the generation
  transport cap)`. Lower that seat's `maxTokens`, or take the role off it, before
  you continue.

## 1. Enter the idle window

Wait until no dispatch, workflow or long-lived tick is running.
`penumbra update --check` is read-only. It reports idle only when the daemon
has nothing in flight and the worker has no job scopes or busy children. For a
chain or workflow run you started yourself, confirm that it is terminal with the
MCP `chain_status` (by conversation id) or `workflow_status` (by run id). Then
stop the watchdog first, if it is installed, so it does not restart anything.
Then stop the worker and the daemon:

```bash
WATCHDOG=~/Library/LaunchAgents/dev.penumbra.watchdog.plist
if [ -f "$WATCHDOG" ]; then launchctl bootout "gui/$UID_" "$WATCHDOG"; else echo "no watchdog installed"; fi
launchctl bootout "gui/$UID_" ~/Library/LaunchAgents/dev.penumbra.worker.plist
launchctl bootout "gui/$UID_" ~/Library/LaunchAgents/dev.penumbra.daemon.plist
pgrep -fl 'penumbra.ts serve|agentchat-worker' || echo "no writers"
```

Do not continue while any process still has `$DB` open (`lsof "$DB"`).

## 2. Take a consistent backup

```bash
mkdir -p "$BACKUP_DIR"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "$DB" ".backup '$BACKUP_DIR/db.sqlite'"
sqlite3 "file:$BACKUP_DIR/db.sqlite?mode=ro&immutable=1" \
  "PRAGMA quick_check; SELECT value FROM db_meta WHERE key='schema_version';"
```

Expect `ok` and `47`. Verify the copy with the `immutable=1` URI. A plain
`-readonly` open can fail or block on a WAL database. Record the backup path
and the `sha256sum`/`shasum -a 256` of the copy in the change log.

## 3. Compare existing index definitions by name

`CREATE INDEX IF NOT EXISTS` matches by name only. An index with the right name
but an older definition, such as one built by hand during the research phase,
is silently kept. Compare each stored definition with the source:

```bash
cd "$REPO" && bun -e '
import { CONTROL_PLANE_INDEX_SQL, DEFERRED_ACTIVITY_INDEX_SQL } from "./packages/core/src/db/control-plane-indexes.ts";
import { Database } from "bun:sqlite";
const norm = (s) => s.replace(/IF NOT EXISTS\s+/i, "").replace(/\s+/g, " ").replace(/\s*([(),=])\s*/g, "$1").trim();
const db = new Database(`file:${process.env.DB}?mode=ro&immutable=1`, { readonly: true });
for (const sql of [...CONTROL_PLANE_INDEX_SQL, DEFERRED_ACTIVITY_INDEX_SQL]) {
  const name = /INDEX IF NOT EXISTS (\S+)/.exec(sql)[1];
  const row = db.query("SELECT sql FROM sqlite_master WHERE type=\x27index\x27 AND name=?").get(name);
  console.log(name, !row ? "ABSENT" : norm(row.sql) === norm(sql) ? "MATCH" : "DRIFT\n  live: " + norm(row.sql) + "\n  src:  " + norm(sql));
}'
```

(Run it with `DB="$DB" bun -e ...`.)

- `MATCH`: the boot build skips it.
- `ABSENT` for one of the three `t1_*` / `dream_actions` indexes: build it now
  under the deadline in step 6. Otherwise boot builds it inside the write
  transaction.
- `DRIFT`: `DROP INDEX <name>;`, then rebuild it under the deadline in step 6.
  Do not boot with a drifted definition. The query planner assumes the source
  definition (the covering column order and the partial `WHERE`).

## 4. The 47 to 49 stamp is one-way

On first boot, `migrate` writes `db_meta.schema_version = 49`. After that,
`assertSchemaNotNewer` makes every schema-47 binary refuse to start with
`schema_version 49 is newer than this build supports (47)`. That refusal is
intentional:

- Do not boot a schema-47 build against this store after the cutover.
- Do not hand-edit `schema_version` back to 47. The 47 code would run against
  `policy_version` rows and dedupe markers it does not understand.
- Rollback is either a schema-49-compatible build (step 9) or restoring the
  step 2 backup, which loses every write made after the window opened.

## 5. Preview the lane-ledger re-dedupe

The dedupe marker is keyed to the schema version, so the first schema-49 boot
dedupes again. For each `implementer_handoff` with more than one open row, it
keeps the newest open lane. It closes the rest with `gate_status='skipped'` and
`override_reason='schema dedupe: duplicate open lane superseded by <lane_id>'`.
Preview what it will close:

```bash
sqlite3 "file:$DB?mode=ro&immutable=1" "
SELECT implementer_handoff, COUNT(*) AS open_rows
FROM lane_ledger WHERE ts_closed IS NULL
GROUP BY implementer_handoff HAVING COUNT(*) > 1;"
```

An empty result means the dedupe changes nothing. Otherwise, record the
handoffs. Their older duplicates are closed at boot. Close any of them yourself
with `lane_close` first if you need a reviewed `gate_status`.

## 6. Build deferred and missing indexes under a deadline

SQLite has no statement timeout, so wrap each build in a wall-clock alarm. If
the alarm fires, the `sqlite3` process dies mid-statement. SQLite then rolls
back the uncommitted index build on the next open, and the store is unchanged.

```bash
build() { # $1 = deadline seconds, $2 = SQL
  perl -e 'alarm shift; exec @ARGV' "$1" \
    sqlite3 -cmd ".timeout 2000" "$DB" "$2" \
    && echo "built" || echo "deadline hit or error: rolled back"
}
cd "$REPO"
ACT_SQL=$(bun -e 'import { DEFERRED_ACTIVITY_INDEX_SQL as s } from "./packages/core/src/db/control-plane-indexes.ts"; console.log(s)')
build 300 "$ACT_SQL"
```

For any `ABSENT` or dropped `DRIFT` index from step 3, print its statement from
`CONTROL_PLANE_INDEX_SQL` the same way and run `build 300 "<sql>"`.

If the activity index hits its deadline, leave it absent. It is an
optimization, not a correctness requirement. Retry it in a later idle window,
or skip it. Do not move it back into the boot path.

## 7. Boot the schema-49 build

Install the build by hand. Do not use `penumbra update --apply` here. Its idle
probe requires a running daemon, and step 1 has booted the daemon out. Its
service restart (`launchctl kickstart -k`) also fails on unloaded labels. Even
before step 1 it would be wrong, because it would boot schema 49 before the
backup and the index checks.

Fast-forward the live checkout and install the locked dependencies while the
services are still stopped:

```bash
git -C "$LIVE" status --porcelain   # must print nothing
git -C "$LIVE" fetch origin
git -C "$LIVE" merge --ff-only "$NEW_SHA"
test "$(git -C "$LIVE" rev-parse HEAD)" = "$NEW_SHA" && echo "at $NEW_SHA"
(cd "$LIVE" && bun install --frozen-lockfile)
```

Make sure the step 0 environment is in the daemon plist. Then bootstrap the
services in reverse order. The daemon's first start is the schema-49 boot
(step 4):

```bash
launchctl bootstrap "gui/$UID_" ~/Library/LaunchAgents/dev.penumbra.daemon.plist
launchctl bootstrap "gui/$UID_" ~/Library/LaunchAgents/dev.penumbra.worker.plist
WATCHDOG=~/Library/LaunchAgents/dev.penumbra.watchdog.plist
if [ -f "$WATCHDOG" ]; then launchctl bootstrap "gui/$UID_" "$WATCHDOG"; fi
```

## 8. Post-checks

```bash
PORT=$(cat "$ROOT/port")
curl -fsS "http://127.0.0.1:$PORT/health"
sqlite3 "file:$DB?mode=ro" "
SELECT key, value FROM db_meta
 WHERE key IN ('schema_version','lane_ledger_open_dedupe_schema_version');
SELECT name FROM sqlite_master WHERE type='index' AND name IN (
 't1_promotion_eligible_lookup','t1_promotion_claim_lookup',
 'idx_dream_actions_phase_status','idx_dispatch_events_activity_end_ts');
EXPLAIN QUERY PLAN SELECT MAX(ts) FROM dispatch_events
 WHERE kind IN ('dispatch.end','long_lived.tick.end');
SELECT COUNT(*) FROM lane_ledger WHERE override_reason LIKE 'schema dedupe:%';"
# Every route except /health needs the daemon bearer token. The CLI reads it from
# "$ROOT/token". curl takes the header on stdin (-H @-), so the token never shows
# in argv, in the shell trace or on screen.
curl -fsS -H @- "http://127.0.0.1:$PORT/dreaming/health" \
  <<<"Authorization: Bearer $(tr -d '[:space:]' < "$ROOT/token")"
```

You can also call the MCP `dreaming_health` tool, which goes through the same
token.

Expect all of the following:

- `schema_version` and `lane_ledger_open_dedupe_schema_version` are both `49`.
- The three boot indexes are present. The activity index is present if step 6
  built it.
- The idle-check plan shows `USING INDEX idx_dispatch_events_ts`, or the
  activity index if it was built. It must not show a bare `SCAN dispatch_events`.
- The dedupe count matches the step 5 preview.
- After the next dreaming cycle, `/dreaming/health` shows P4 skipped, and no new
  `dream_actions` rows have `phase='P4'` and `action_type='research_query'`.
- The daemon log has no `invalid generation maxTokens` errors, no `cannot serve
  generation role` refusals (step 0) and no `abstaining from memory research`
  inventory warnings (step 0, item 2).
- `PENUMBRA_LOCAL_JUDGE_SHADOW` is unset or false. Jev authority and the
  Kapitsa and Gufo seats are unchanged.

Keep the step 2 backup until the store has run cleanly through at least one full
dreaming cycle and one T2 promotion tick.

## 9. Rollback

Never roll back by booting the schema-47 binary (step 4). In order of
preference:

1. **A schema-49-compatible build with P4 disabled and Q8 retained.** Keep
   `SCHEMA_VERSION = 49`, keep `P4` in `PENUMBRA_DREAMING_SKIP_PHASES`, and keep
   the Granite Q8 rewriter model (`PENUMBRA_DREAMING_REWRITER_MODEL` default).
   Revert only the offending change on top of this build. Do not restore the old
   title-fallback code path, and do not swap Q8 for Q4.
2. **Drop the deferred activity index** if it is implicated:
   `DROP INDEX IF EXISTS idx_dispatch_events_activity_end_ts;`. Nothing depends
   on it.
3. **Restore the step 2 backup** as a last resort, together with the schema-47
   build. Stop all writers first, as in step 1, then copy the backup over `$DB`
   and remove `$DB-wal` and `$DB-shm`. Every write made since the window opened
   is lost.
