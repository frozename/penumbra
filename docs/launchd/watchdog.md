# Daemon liveness watchdog

`penumbra watchdog` is a one-pass external liveness check. It first probes
`http://127.0.0.1:<port>/health`, where `<port>` is read from the storage root's
`port` file. If that is unavailable, it uses
`launchctl print gui/<uid>/dev.penumbra.daemon` to distinguish an absent launchd
service from a present but unhealthy one.

By default it only observes. `--heal` enables the corrective action:

- absent service: `launchctl bootstrap gui/<uid> <daemon plist>`;
- present but unhealthy service: `launchctl kickstart -k gui/<uid>/dev.penumbra.daemon`.

Every pass prints a single JSON object to stdout. Down observations are logged at
error level with the event name `penumbra_watchdog_daemon_down` and appended to
`<storage-root>/watchdog.jsonl`. Each record carries `downSince` and
`downtimeMs`; a later healthy record closes the active outage without rewriting
earlier evidence.

## Install the LaunchAgent manually

The template at [dev.penumbra.watchdog.plist](./dev.penumbra.watchdog.plist) is
intentionally not installed by this repository. Copy it to
`~/Library/LaunchAgents/dev.penumbra.watchdog.plist` and replace all three
placeholders before loading it:

- `__BUN_PATH__`: the absolute result of `command -v bun`;
- `__PENUMBRA_REPO__`: the absolute path to this checkout;
- `__PENUMBRA_STORAGE_ROOT__`: the daemon's existing storage root.

Validate and load it from a terminal after reviewing the concrete values:

```sh
plutil -lint ~/Library/LaunchAgents/dev.penumbra.watchdog.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.penumbra.watchdog.plist
launchctl kickstart -k "gui/$(id -u)/dev.penumbra.watchdog"
```

The unit invokes the watchdog at load and every 60 seconds. It is separate from
the daemon and therefore can observe the daemon being absent. Its standard
output and error logs are retained under the configured storage root.

To uninstall it manually:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/dev.penumbra.watchdog.plist
rm ~/Library/LaunchAgents/dev.penumbra.watchdog.plist
```

No LaunchAgent has been installed or modified by this change. A future follow-up
can project the JSONL watchdog records into `subsystem_health` once that schema
work is available; this implementation deliberately makes no database changes.
