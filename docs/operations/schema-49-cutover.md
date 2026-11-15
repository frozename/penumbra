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
export ROOT="${PENUMBRA_STORAGE_ROOT:-$HOME/.penumbra}"   # holds db.sqlite, port and token
export DB="$ROOT/db.sqlite"
BACKUP_DIR="$HOME/.penumbra/backups/schema-49-$(date -u +%Y%m%dT%H%M%SZ)"
REPO=/path/to/penumbra-49   # a git checkout or worktree that has $NEW_SHA
NEW_SHA=<full sha of the schema-49 build>
UID_=$(id -u)
DAEMON_PLIST=~/Library/LaunchAgents/dev.penumbra.daemon.plist
WORKER_PLIST=~/Library/LaunchAgents/dev.penumbra.worker.plist
```

`ROOT` and `DB` are exported because the `bun` snippets read them from the
environment. `REPO` can be a separate worktree at `$NEW_SHA`. The `bun` snippets
in steps 0, 3 and 6 only import source from it, and step 7 exports the new
snapshot from it. The services are not repointed until step 7, after they are
stopped.

## 0. Deploy prerequisites (before the window)

Set both of these in the daemon LaunchAgent environment
(`~/Library/LaunchAgents/dev.penumbra.daemon.plist`, `EnvironmentVariables`).
Edit the plist with `plutil`; do not hand-merge it.

1. **Turn the rewriter off.** Production runs
   `PENUMBRA_DREAMING_REWRITER_ENABLED=1`. With that flag set, the schema-49
   build sends the R2 rewriter prompt to the live rewriter. The research verdict
   on that prompt is NO-GO (tag `research/system-one-judges-2026-11-14`). Set
   `PENUMBRA_DREAMING_REWRITER_ENABLED=0`, or remove the key (the default is
   false):

   ```bash
   plutil -replace EnvironmentVariables.PENUMBRA_DREAMING_REWRITER_ENABLED -string 0 "$DAEMON_PLIST"
   plutil -extract EnvironmentVariables.PENUMBRA_DREAMING_REWRITER_ENABLED raw -o - "$DAEMON_PLIST"; echo
   ```

   The second command prints only that one value. P4 still runs every cycle. It
   queues contradiction actions and prunes the rewrite cache. But every memory it
   considers abstains before any rewriter call: it records a
   `dream_p4_query_skipped` dispatch event with `reason` `rewriter_disabled`,
   and no `research_query` action is queued.

   Adding `P4` to `PENUMBRA_DREAMING_SKIP_PHASES` does **not** turn P4 or the
   rewriter off. Only P7 reads `skipPhases`, and `runCycleP4` runs on every
   cycle.
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

Fix every refusal before the window. The daemon handles a refused role
differently for each caller:

- **T2 extraction pool** (`PENUMBRA_T2_EXTRACTION_ROLE`, then
  `PENUMBRA_JUDGE_ROLE`, then `memory-refiner`): the pool throws when it is
  created, so `serve()` startup aborts and the KeepAlive LaunchAgent
  crash-loops. On the research tag build this seat also threw at pool creation, from the
  transport options.
- **Memory efficacy** (`PENUMBRA_JUDGE_ROLE`, default `memory-refiner`) and the
  **dispatch refiner** (`PENUMBRA_REFINER_ROLE`, default `refiner`): the
  refused seat is dropped with a warning that names the role, and the other
  seats serve in order. If every seat is refused, the role is disabled with a
  warning, and each efficacy job or `/dispatch/refine` request fails (502
  `refiner_upstream_failed`). The legacy judge endpoint is not used instead.
- **Dreaming judge pool**, **brief synthesizer** and **rewriter**: the refusal
  is logged and that feature falls back. The judge pool uses the stub pool, the
  brief synthesizer writes no brief, and the rewriter uses the legacy
  `PENUMBRA_DREAMING_REWRITER_*` candidate.

By default efficacy and T2 share `memory-refiner`, so an over-cap
`memory-refiner` seat still aborts startup through the T2 pool.

## 1. Enter the idle window

Wait until no dispatch, workflow or long-lived tick is running.

`penumbra update --check --repo "$REPO"` helps here. Read its limits first:

- It is read-only apart from a `git fetch` in the `--repo` checkout.
- `--repo` defaults to the checkout the CLI itself runs from. On this host the
  CLI runs from a non-git snapshot (step 7), so that default fails. Pass
  `--repo`.
- Its idle probe runs with `requireDaemon: false`. An unreachable daemon is not
  counted as busy, so `activity: idle` alone proves nothing. Trust it only when
  the same report shows `daemon: healthy` and has no `in-flight handoffs
  unknown:` line. When the daemon answers, idle means no dispatched or approved
  handoffs, no job scopes and no busy worker children.
- The `runs from:` line and any `--apply would refuse` lines describe
  `--apply`. They do not matter here.

For a chain you started yourself, confirm that it is terminal with the MCP
`chain_status`, which takes the `handoff_id` that `chain_start` returned. For a
workflow run, use `workflow_status` with its run id. Then stop the watchdog
first, if it is installed, so it does not restart anything. Then stop the worker
and the daemon:

```bash
WATCHDOG=~/Library/LaunchAgents/dev.penumbra.watchdog.plist
if [ -f "$WATCHDOG" ]; then launchctl bootout "gui/$UID_" "$WATCHDOG"; else echo "no watchdog installed"; fi
launchctl bootout "gui/$UID_" "$WORKER_PLIST"
launchctl bootout "gui/$UID_" "$DAEMON_PLIST"
pgrep -fl 'penumbra.ts start|agentchat-worker' || echo "no writers"
```

The daemon runs as `penumbra.ts start --port <port>`. There is no `serve`
subcommand.

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
cd "$REPO" && DB="$DB" bun -e '
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
Preview what it will close, and record the two counts that step 8 compares:

```bash
sqlite3 "file:$DB?mode=ro&immutable=1" "
SELECT implementer_handoff, COUNT(*) AS open_rows
FROM lane_ledger WHERE ts_closed IS NULL
GROUP BY implementer_handoff HAVING COUNT(*) > 1;"
EXPECTED_CLOSES=$(sqlite3 "file:$DB?mode=ro&immutable=1" "
SELECT COALESCE(SUM(open_rows - 1), 0) FROM (
  SELECT COUNT(*) AS open_rows FROM lane_ledger WHERE ts_closed IS NULL
  GROUP BY implementer_handoff HAVING COUNT(*) > 1);")
DEDUPE_BEFORE=$(sqlite3 "file:$DB?mode=ro&immutable=1" "
SELECT COUNT(*) FROM lane_ledger WHERE override_reason LIKE 'schema dedupe:%';")
echo "expected closes: $EXPECTED_CLOSES; schema-dedupe rows before boot: $DEDUPE_BEFORE"
```

The services are stopped and step 2 truncated the WAL, so the `immutable=1`
read is current. An empty first result (and `EXPECTED_CLOSES` of 0) means the
dedupe changes nothing. Otherwise, record the handoffs. Their older duplicates
are closed at boot. `DEDUPE_BEFORE` can be non-zero, because earlier schema
dedupe runs, such as the schema-47 one, wrote the same reason prefix. Step 8 therefore
compares the change in that count, not the count itself. If you need a reviewed
`gate_status` for any of these lanes, close it with `lane_close` before step 1
(it needs the daemon), then rerun this step in the window.

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
service restart (`launchctl kickstart -k`) also fails on unloaded labels. It
only moves a git checkout, and on this host the services do not run from one.
Even before step 1 it would be wrong, because it would boot schema 49 before the
backup and the index checks.

### 7a. Snapshot install (this host)

On this host the daemon and worker LaunchAgents run from a non-git snapshot
directory. Their `ProgramArguments` point bun at
`<snapshot>/packages/cli/bin/penumbra.ts start --port <port>` and
`<snapshot>/packages/agentchat/bin/agentchat-worker.ts`. Check which layout you
have. These commands print only the program arguments, never
`EnvironmentVariables`:

```bash
plutil -extract ProgramArguments json -o - "$DAEMON_PLIST"; echo
plutil -extract ProgramArguments json -o - "$WORKER_PLIST"; echo
OLD_SNAP=$(plutil -extract ProgramArguments.1 raw -o - "$DAEMON_PLIST" | sed 's#/packages/cli/bin/penumbra.ts$##')
if [ -e "$OLD_SNAP/.git" ]; then echo "git checkout: use 7b"; else echo "snapshot: $OLD_SNAP"; fi
```

Build a new snapshot of `$NEW_SHA` next to the old one. Never edit a snapshot
in place, and never reuse a path: the old snapshot is the rollback target.

```bash
DEPLOY_ROOT=$(dirname "$(dirname "$OLD_SNAP")")   # the layout is <root>/<sha12>/source
NEW_SNAP="$DEPLOY_ROOT/${NEW_SHA:0:12}/source"
test ! -e "$NEW_SNAP" && mkdir -p "$NEW_SNAP" \
  && git -C "$REPO" archive "$NEW_SHA" | tar -x -C "$NEW_SNAP" \
  && (cd "$NEW_SNAP" && bun install --frozen-lockfile) \
  && echo "snapshot ready: $NEW_SNAP"
```

`git archive` exports exactly the tracked tree at `$NEW_SHA`, with no `.git` and
nothing uncommitted. The workspace packages export their TypeScript sources, so
there is no build step. A detached git worktree
(`git -C "$REPO" worktree add --detach "$NEW_SNAP" "$NEW_SHA"`, then the same
`bun install`) also works, as long as nothing edits it afterwards.

Copy both plists into the backup, then repoint `ProgramArguments`. Replace the
whole array: on this macOS, `plutil -replace ProgramArguments.N` inserts an
element instead of replacing it. Leave `WorkingDirectory` and
`EnvironmentVariables` as they are.

```bash
cp "$DAEMON_PLIST" "$WORKER_PLIST" "$BACKUP_DIR/" && chmod 600 "$BACKUP_DIR"/*.plist
repoint() { # $1 = plist, $2 = from snapshot, $3 = to snapshot
  local args
  args=$(plutil -extract ProgramArguments json -o - "$1" | FROM="$2" TO="$3" bun -e '
const { FROM, TO } = process.env;
const argv = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(argv.map((a) => (a.startsWith(FROM + "/") ? TO + a.slice(FROM.length) : a))));') &&
    plutil -replace ProgramArguments -json "$args" "$1" &&
    plutil -extract ProgramArguments json -o - "$1" && echo
}
repoint "$DAEMON_PLIST" "$OLD_SNAP" "$NEW_SNAP"
repoint "$WORKER_PLIST" "$OLD_SNAP" "$NEW_SNAP"
plutil -lint "$DAEMON_PLIST" "$WORKER_PLIST"
```

Both printed arrays must point into `$NEW_SNAP`.

To go back before the first schema-49 boot, for example when the snapshot
build failed, run `repoint "$DAEMON_PLIST" "$NEW_SNAP" "$OLD_SNAP"` and the same
for `$WORKER_PLIST`. This only works while the store is still at schema 48 or
lower. The old snapshot is the schema-47 build. Once `migrate` has stamped 49,
that build refuses to start (step 4). After the stamp, use step 9.

### 7b. Git checkout install (alternative)

If `ProgramArguments` points into a git checkout instead (`LIVE` below), keep
the plists as they are. Fast-forward the checkout and install the locked
dependencies while the services are still stopped:

```bash
LIVE=/path/to/penumbra      # the checkout the daemon and worker LaunchAgents run from
git -C "$LIVE" status --porcelain   # must print nothing
git -C "$LIVE" fetch origin
git -C "$LIVE" merge --ff-only "$NEW_SHA"
test "$(git -C "$LIVE" rev-parse HEAD)" = "$NEW_SHA" && echo "at $NEW_SHA"
(cd "$LIVE" && bun install --frozen-lockfile)
```

The same one-way limit applies to moving it back.

### 7c. Bootstrap

Make sure the step 0 environment is in the daemon plist. Record the boot time
for the step 8 checks. Then bootstrap the services in reverse order. The
daemon's first start is the schema-49 boot (step 4):

```bash
T0_S=$(date +%s); T0_ISO=$(date -u -r "$T0_S" +%Y-%m-%dT%H:%M:%S.000Z); T0_MS=$((T0_S * 1000))
launchctl bootstrap "gui/$UID_" "$DAEMON_PLIST"
launchctl bootstrap "gui/$UID_" "$WORKER_PLIST"
WATCHDOG=~/Library/LaunchAgents/dev.penumbra.watchdog.plist
if [ -f "$WATCHDOG" ]; then launchctl bootstrap "gui/$UID_" "$WATCHDOG"; fi
```

## 8. Post-checks

Run these while the daemon is up. A `mode=ro` open of a WAL database needs the
`-shm` file that the running daemon keeps. Steps 5 and 7c set
`EXPECTED_CLOSES`, `DEDUPE_BEFORE`, `T0_ISO` and `T0_MS`, so use the same shell.

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
 WHERE kind IN ('dispatch.end','long_lived.tick.end');"
DEDUPE_AFTER=$(sqlite3 "file:$DB?mode=ro" "
SELECT COUNT(*) FROM lane_ledger WHERE override_reason LIKE 'schema dedupe:%';")
echo "dedupe closed $((DEDUPE_AFTER - DEDUPE_BEFORE)) row(s); step 5 expected $EXPECTED_CLOSES"
# Every route except /health needs the daemon bearer token. The CLI reads it from
# "$ROOT/token". curl takes the header on stdin (-H @-), so the token never shows
# in argv, in the shell trace or on screen.
curl -fsS -H @- "http://127.0.0.1:$PORT/dreaming/health" \
  <<<"Authorization: Bearer $(tr -d '[:space:]' < "$ROOT/token")"
```

You can also call the MCP `dreaming_health` tool, which goes through the same
token.

After the first dreaming cycle that starts after `T0`, check that P4 made no
rewriter calls:

```bash
sqlite3 "file:$DB?mode=ro" "
SELECT cycle_id, outcome, phases_run FROM dream_cycles
 WHERE started_at >= $T0_MS ORDER BY started_at;
SELECT kind, json_extract(meta_json, '\$.reason') AS reason, COUNT(*) AS n
 FROM dispatch_events WHERE ts >= '$T0_ISO' AND kind LIKE 'dream_p4_%' GROUP BY 1, 2;
SELECT COUNT(*) AS new_research_queries FROM dream_actions
 WHERE phase = 'P4' AND action_type = 'research_query'
   AND cycle_id IN (SELECT cycle_id FROM dream_cycles WHERE started_at >= $T0_MS);
SELECT subsystem, last_success_ts, last_failure_ts, last_skip_ts FROM subsystem_health
 WHERE subsystem = 'dream.query_rewrite';"
```

Expect all of the following:

- `schema_version` and `lane_ledger_open_dedupe_schema_version` are both `49`.
- The three boot indexes are present. The activity index is present if step 6
  built it.
- The idle-check plan shows `USING INDEX idx_dispatch_events_ts`, or the
  activity index if it was built. It must not show a bare `SCAN dispatch_events`.
- The dedupe delta (`DEDUPE_AFTER - DEDUPE_BEFORE`) equals `EXPECTED_CLOSES`
  from step 5, that is `SUM(open_rows - 1)` over the duplicated handoffs.
- The rewriter is off (step 0, item 1). A cycle after `T0` lists `P4` in
  `phases_run`, because P4 always runs. Every `dream_p4_%` event since `T0` is
  `dream_p4_query_skipped` with reason `rewriter_disabled`. There are no
  `dream_p4_query_rewritten`, `dream_p4_query_rewrite_failed` or
  `dream_p4_query_rejected_unsearchable` rows. There are no events at all when
  no project sets `dreaming.research_provider`. `new_research_queries` is 0.
  The `dream.query_rewrite` timestamps in `subsystem_health` are all before
  `T0_ISO`, or the row is absent. The `/dreaming/health` `query_*_recent`
  counters cover a fixed window that starts before the cutover, so use the SQL.
- The daemon log has no `invalid generation maxTokens` errors and no `cannot
  serve generation role` refusals (step 0). For efficacy and the refiner, that
  includes the `dropped a seat refused for generation role` and `disabled:
  every seat was refused` warnings. While the rewriter is disabled, P4 does not
  read the inventory, so a missing `abstaining from memory research` warning
  does not prove step 0, item 2. Check that item again before you enable the
  rewriter.
- `PENUMBRA_LOCAL_JUDGE_SHADOW` is unset or false. Jev authority and the
  Kapitsa and Gufo seats are unchanged.

Keep the step 2 backup until the store has run cleanly through at least one full
dreaming cycle and one T2 promotion tick.

## 9. Rollback

Never roll back by booting the schema-47 binary (step 4). In order of
preference:

1. **A schema-49-compatible build with the rewriter disabled and Q8
   retained.** Keep `SCHEMA_VERSION = 49`, keep
   `PENUMBRA_DREAMING_REWRITER_ENABLED=0` (or unset), and keep the Granite Q8
   rewriter model (`PENUMBRA_DREAMING_REWRITER_MODEL` default). Revert only the
   offending change on top of this build. Do not restore the old title-fallback
   code path, and do not swap Q8 for Q4. Install it as a new snapshot and
   repoint to it (step 7a), or fast-forward a git install (step 7b).
2. **Drop the deferred activity index** if it is implicated:
   `DROP INDEX IF EXISTS idx_dispatch_events_activity_end_ts;`. Nothing depends
   on it.
3. **Restore the step 2 backup** as a last resort, together with the schema-47
   build. Stop all writers first, as in step 1, then copy the backup over `$DB`
   and remove `$DB-wal` and `$DB-shm`. Point the services back at the old
   snapshot with `repoint "$DAEMON_PLIST" "$NEW_SNAP" "$OLD_SNAP"` and the same
   for `$WORKER_PLIST` (or copy the step 7a plist backups back), then bootstrap
   as in step 7c. Every write made since the window opened is lost.
